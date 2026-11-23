"""Astra controls a named design, reviews actual renders and repairs failed builds."""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass

from ..utils.llm_tool_conversation import ToolSpec
from .assembly import Assembly, assemble
from .design import SECTION_NAME, sections
from .parts import SHAPES
from .render import Views

MODEL = "gpt-6.2-astra"
SYSTEM = """You are Astra, BrickBuilder's LEGO designer. Build a recognizable freestanding
3D interpretation of the user's brief and optional reference photograph. Study the subject's
silhouette, relative proportions, color blocks, inset details and negative space. Pick a scale
that leaves room for those details within the budget. Pay attention to its side and rear.
Keep the front of the subject toward -Z. The front camera sees that face and its left side.
When a design exists, its current front and rear views accompany the section text.
Compare them with the reference on this turn. Change the design or finish the reviewed revision.
Use the tools to build, look at both actual renderings, and repair your work. Finish only
when the shape matches the reference, colors and features read clearly, and all checks pass.

Write named sections of plain text, one command per line. Coordinates are integer left/bottom/front
corners in X Y Z order. X increases right, Y upward in PLATES (3 per brick), Z toward the back.
Widths/depths are studs. All colors are numeric LDraw IDs. Each distinct piece must connect
through real top studs to the assembly. A landscape usually needs two plate courses to tie
its seams. Place footprints and attachments deliberately. Keep large volumes hollow.

box COLOR X Y Z WIDTH HEIGHT DEPTH
shell COLOR X Y Z WIDTH HEIGHT DEPTH
profile COLOR X Y Z FACE THICKNESS ROWS
roof COLOR X Y Z WIDTH DEPTH RIDGE PITCH GABLE_COLOR
part ID COLOR X Y Z TURN
repeat COUNT DX DY DZ COMMAND...

box fills a cuboid. shell makes perimeter walls open at top and bottom. profile extrudes
a freehand silhouette. Write equal-width rows of # and . separated by / with no spaces.
For front or side profiles the first row is highest, and each row is one PLATE high.
Side rows run from front to back. Top rows run from front to back with X across.
Thickness is along the extrusion axis, in plates for top, studs otherwise. Later solids
recolor/replace earlier ones in section order. Use color -1 in a box or profile to carve.
Roof adds a one-plate deck, two sloped faces, end infill and a ridge cap. RIDGE x or z runs
parallel to that axis. PITCH is steep (45 degrees), shallow (33), or gambrel (steep then
shallow). The width across the ridge must be at least four studs. Position a roof on top
of the wall studs. Example: roof 72 4 12 2 10 9 z gambrel 15.
Detail parts replace solid cells in their footprint. Two explicit parts cannot overlap.
TURN 0..3 rotates by quarter turns, keeping the given minimum corner. A native 1x4 part
runs four studs along X. Turn 1 runs it along Z. Tiles and fences have smooth tops.
Use find_parts for the exact color IDs for a part, particularly slopes and transparent
bricks. Useful details include lattice fence 3633, window frames 60592 (2w x 6 plates)
and 60594 (4w x 9 plates), grille 2412b, masonry 98283, round brick 3062b and round
plate 4073. Repetition applies to a single command.
Common colors include 15 white, 0 black, 71 light gray, 72 dark gray, 272 dark blue,
1 blue, 2 green, 288 dark green, 378 sand green, 19 tan, 28 dark tan, 70 brown, 4 red,
14 yellow, 25 orange, 47 clear, 40 trans brown and 43 trans light blue.
Each edit replaces the entire named section. Send only changed sections on later turns.
If a component is detached, use the reported part and coordinates to bridge it to the
rest of the build. Use find_parts to check substitutions. You can revise repeatedly."""


def obj(**properties):
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


STRING = {"type": "string"}
FINISH = ToolSpec(
    "finish",
    "Accept a checked revision after seeing its two views and comparing them with the user's input.",
    obj(revision={"type": "integer"}, assessment=STRING),
)
TOOLS = [
    ToolSpec(
        "find_parts",
        "Find supported physical templates by ID or name and list stock colors.",
        obj(query=STRING),
    ),
    ToolSpec(
        "revise",
        "Replace named sections, or delete a section with an empty program. "
        "Returns connectivity, part count and two rendered views of the result.",
        obj(sections={"type": "array", "items": obj(name=STRING, program=STRING)}),
    ),
    FINISH,
]
FINAL_TOOLS = [
    FINISH,
    ToolSpec("decline", "Decline a visually inadequate model.", obj(reason=STRING)),
]


@dataclass(frozen=True)
class Candidate:
    revision: int
    program: dict
    assembly: Assembly
    views: Views

    def accept(self, args):
        if type(args.get("revision")) is not int or args["revision"] != self.revision:
            raise ValueError("Use the exact reviewed revision number")
        assessment = args.get("assessment")
        if not isinstance(assessment, str) or not 1 <= len(assessment.strip()) <= 2000:
            raise ValueError("Give a brief visual assessment")
        return Build(self.program, self.assembly, self.views, assessment.strip())


@dataclass
class Build:
    program: dict
    assembly: Assembly
    views: Views
    assessment: str


class Designer:
    def __init__(self, catalog, limit, render, program, report, checkpoint):
        self.catalog, self.limit, self.render = catalog, limit, render
        self.program = dict(program or {})
        self.report = report
        self.checkpoint = checkpoint
        self.checked = None
        self.revision = 0
        self.model = self.views = self.seen_on = None

    def find(self, query):
        if not isinstance(query, str) or len(query) > 100:
            raise ValueError("Use a short part ID or description")
        query = query.strip().casefold().removesuffix(".dat")
        matches = {}
        for (part, color), stock in self.catalog.parts.items():
            if (
                part in SHAPES
                and stock.max_quantity != 0
                and (query in part or query in stock.name.casefold())
            ):
                matches.setdefault(part, []).append(color)
        lines = []
        for part in sorted(matches):
            shape = SHAPES[part]
            colors = sorted(matches[part])
            name = self.catalog.parts[part, colors[0]].name
            lines.append(
                f"{part} {name}, {shape.width}w {shape.depth}d {shape.height} plates, "
                f"top {shape.top}, colors {','.join(map(str, colors))}"
            )
        return "\n".join(lines[:18]) or "No supported geometry for that search"

    def revise(self, changes):
        if not isinstance(changes, list) or not 1 <= len(changes) <= 48:
            raise ValueError("Send 1..48 named section changes")
        proposed = self.program.copy()
        names = set()
        for change in changes:
            if not isinstance(change, dict) or change.keys() != {"name", "program"}:
                raise ValueError("A section needs a name and a program")
            name, body = change["name"], change["program"]
            if not isinstance(name, str) or not SECTION_NAME.fullmatch(name) or name in names:
                raise ValueError("Use distinct, short section names")
            if not isinstance(body, str) or len(body) > 8192:
                raise ValueError("Section text exceeds 8192 characters")
            names.add(name)
            if body.strip():
                proposed[name] = body.strip()
            else:
                proposed.pop(name, None)
        # Keep invalid drafts editable, but always invalidate the previous approval.
        self.program = sections(proposed)
        self.revision += 1
        self.model = self.views = self.seen_on = None
        if self.checkpoint:
            self.checkpoint(self.program, False)

    async def inspect(self, turn):
        if self.model is None:
            self.model = await asyncio.to_thread(assemble, self.program, self.catalog, self.limit)
        if self.views is None:
            self.views = await asyncio.to_thread(self.render, self.model)
        self.seen_on = turn
        if not self.model.issues:
            self.checked = Candidate(self.revision, self.program, self.model, self.views)
            if self.checkpoint:
                self.checkpoint(self.program, True)
        issues = " | ".join(self.model.issues) or "One connected stud group. Checks passed."
        status = f"Revision {self.revision}, {len(self.model.pieces)}/{self.limit} pieces. {issues}"
        self.report(status)
        return status + " Views show front-left and rear-right."

    def finish(self, args, turn):
        if (
            type(args.get("revision")) is not int
            or args["revision"] != self.revision
            or self.seen_on is None
            or self.seen_on >= turn
            or self.model.issues
        ):
            raise ValueError(
                "Review this exact revision on a previous turn and resolve its checks first"
            )
        return self.checked.accept(args)


async def design(
    session, catalog, limit, render, *, program=None, report=print, checkpoint=None, rounds=14
):
    designer = Designer(catalog, limit, render, program, report, checkpoint)
    feedback = deque(maxlen=6)
    last = "No reviewed design"
    if program:
        try:
            last = await designer.inspect(-1)
        except ValueError as error:
            last = str(error)
        feedback.append(last)
    for turn in range(rounds):
        view = designer.views.review() if designer.views else None
        state = [
            *feedback,
            f"Current revision {designer.revision}. {rounds - turn} design turns remain.",
        ]
        response = await session.decide(designer.program, state, view)
        if not response.tool_calls:
            feedback.append("Use revise or finish to complete the build.")
            continue
        for call in response.tool_calls:
            try:
                if call.name == "find_parts":
                    result = designer.find(call.input.get("query"))
                elif call.name == "revise":
                    designer.revise(call.input.get("sections"))
                    result = await designer.inspect(turn)
                    last = result
                elif call.name == "finish" and len(response.tool_calls) == 1:
                    return designer.finish(call.input, turn)
                else:
                    raise ValueError("Use find_parts, revise or a single finish call")
            except ValueError as error:
                last = str(error)
                report(f"Repair requested: {last}")
                result = last
            feedback.append(f"{call.name}: {result}")
    # An unsuccessful refinement must not discard a complete, connected design.
    # Show the retained source and its own images together for a final decision.
    candidate = designer.checked
    if candidate:
        report(f"Final visual review of checked revision {candidate.revision}.")
        state = [
            f"Final review of revision {candidate.revision}, {len(candidate.assembly.pieces)} pieces.",
            "Accept if it meets the brief, or decline with the missing requirement.",
        ]
        review = await session.decide(
            candidate.program, state, candidate.views.review(), final_review=True
        )
        if len(review.tool_calls) == 1:
            decision = review.tool_calls[0]
            if decision.name == "finish":
                return candidate.accept(decision.input)
            if decision.name == "decline":
                last = str(decision.input.get("reason", ""))[:2000]
    raise ValueError(f"Astra reached its turn limit without an accepted build. {last}")
