"""A cheaper way to run a build: a few short, stateless rounds.

The thorough method (``agent.BuildAgent``) keeps one growing conversation. That carries the model's
reasoning forward, and it is also what makes a build costly: the model pays to re-read and re-store
everything it has thought and seen, and it spends whole turns on single lookups, edits and renders.

Here every round is a small, fresh request that holds only what is needed to act: the brief, the
current script, its build report and pictures of it. The model answers with one action. Every script
change is checked and rendered straight away, so the next round opens on the result. What the model
wants to remember goes in a short note it writes to itself.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .agent import Event, RunResult, close_run
from .provider import Budget, BudgetExhausted, ModelClient, estimate_tokens
from .render import VIEW_AZIMUTH
from .session import Session
from .tools import ToolError, Toolbox

DEFAULT_VIEWS = ("front-left", "front-right", "back-left")
MAX_NOTE = 1500
MAX_FACTS = 9000
_NOTES = {"type": "string", "description": "What you want to remember next round: decisions and why, what to "
                                           "check or fix next. Under 150 words. It replaces your previous note."}
_VIEWS = {"type": "array", "items": {"type": "string"},
          "description": "Up to 3 views to see next round (default front-left, front-right, back-left). Choose "
                         "from: " + ", ".join(VIEW_AZIMUTH)}


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


LEAN_TOOLS = [
    {
        "name": "build",
        "description": "Write the whole build script, replacing any existing one. It is run, checked and "
                       "rendered; the next round shows you the report and the pictures.",
        "input_schema": _schema({"code": {"type": "string"}, "notes": _NOTES, "views": _VIEWS}, ["code", "notes"]),
    },
    {
        "name": "patch",
        "description": "Change the current script with exact text replacements, applied in order, then run, "
                       "check and render it. Put every fix you can see into one patch. Each 'old' must match "
                       "exactly once unless replace_all is true. If any edit fails, nothing is changed.",
        "input_schema": _schema({
            "edits": {"type": "array", "items": _schema({
                "old": {"type": "string"}, "new": {"type": "string"}, "replace_all": {"type": "boolean"},
            }, ["old", "new"])},
            "notes": _NOTES, "views": _VIEWS,
        }, ["edits", "notes"]),
    },
    {
        "name": "look_up",
        "description": "Measured facts about parts before you use them: size, which way they face, where "
                       "their studs are and their colors. Give part ids, a search phrase, or both. It costs "
                       "a round, so ask for everything you need at once.",
        "input_schema": _schema({
            "parts": {"type": "array", "items": {"type": "string"}},
            "search": {"type": "string"}, "notes": _NOTES,
        }, []),
    },
    {
        "name": "finish",
        "description": "Publish the revision you are looking at this round. Only works when its build report "
                       "has no errors. 'summary' is shown to the customer: say what was built and name any "
                       "honest limitations.",
        "input_schema": _schema({"title": {"type": "string"}, "summary": {"type": "string"}}, ["title", "summary"]),
    },
]
NO_ACTION = "You took no action. Every round must end with exactly one of build, patch, look_up or finish."
CUT_OFF = ("Your reply was cut off by the output limit, so nothing was run. Think more briefly, and use patch "
           "rather than build for a local change.")
BAD_INPUT = "Your tool input was not valid JSON, so nothing was run. Send the action again."


@dataclass(frozen=True)
class Outcome:
    text: str
    failed: bool = False
    finished: bool = False


class LeanAgent:
    def __init__(self, session: Session, client: ModelClient, toolbox: Toolbox, budget: Budget, *,
                 max_rounds: int = 8, max_tokens: int = 20_000, on_event: Event | None = None):
        self._session = session
        self._client = client
        self._toolbox = toolbox
        self._budget = budget
        self._max_rounds = max_rounds
        self._max_tokens = max_tokens
        self._emit = on_event or (lambda kind, data: None)
        self._state = session.meta.setdefault(
            "lean", {"brief": [], "notes": "", "facts": [], "outcome": "", "views": []})

    # ----- one round's request -------------------------------------------

    def _request(self, number: int) -> list[dict]:
        """Everything the model needs to act, and nothing it has already dealt with."""
        state, session = self._state, self._session
        left = self._max_rounds - number
        lines = [f"Round {number}. " + (f"{left} more round{'s' if left != 1 else ''} after this one."
                                       if left else "This is the last round: finish if the report is clean, "
                                                    "otherwise make the build error-free.")]
        if state["notes"]:
            lines += ["", "Your note from the last round:", state["notes"]]
        if state["facts"]:
            lines += ["", "Parts you looked up:", *state["facts"]]
        script = session.script
        if script:
            lines += ["", f"Current build script (revision {session.meta['revision']}):", "```python",
                      script.rstrip(), "```"]
        else:
            lines += ["", "There is no build script yet. Write the whole model with `build`."]
        if state["outcome"]:
            lines += ["", "Result of your last action:", state["outcome"]]
        pictures = [session.image_block(session.path(view)) for view in state["views"]]
        return [*state["brief"], {"type": "text", "text": "\n".join(lines)}, *pictures]

    @staticmethod
    def _with_cache_point(content: list[dict], brief_blocks: int) -> list[dict]:
        """Mark the end of the brief: it is the same every round, the rest is not."""
        marked = list(content)
        marked[brief_blocks - 1] = {**marked[brief_blocks - 1], "cache_control": {"type": "ephemeral"}}
        return marked

    # ----- actions --------------------------------------------------------

    def _remember(self, arguments: dict) -> None:
        notes = arguments.get("notes")
        if isinstance(notes, str) and notes.strip():
            self._state["notes"] = notes.strip()[:MAX_NOTE]

    def _views(self, arguments: dict) -> list[str]:
        views = arguments.get("views")
        if not isinstance(views, list) or not views:
            return list(DEFAULT_VIEWS)
        return [view for view in views if view in VIEW_AZIMUTH][:3] or list(DEFAULT_VIEWS)

    def _rebuild(self, code: str, views: list[str]) -> Outcome:
        """Run and check the script, then look at it: one round shows both."""
        session, state = self._session, self._state
        built = self._toolbox.call("write_script", {"code": code})
        state["views"] = []
        if built.is_error:
            return Outcome(built.text, failed=True)
        rendered = self._toolbox.call("render", {"views": views})
        if rendered.is_error:
            return Outcome(f"{built.text}\nNo pictures: {rendered.text}")
        root = session.directory.resolve()
        state["views"] = [Path(path).resolve().relative_to(root).as_posix() for path in rendered.images]
        return Outcome(f"{built.text}\nPictures of {rendered.text}")

    def _patched(self, edits) -> str:
        script = self._session.script
        if not script:
            raise ToolError("There is no script yet; use build first")
        if not isinstance(edits, list) or not 1 <= len(edits) <= 40:
            raise ToolError("'edits' must list 1 to 40 replacements")
        for number, edit in enumerate(edits, 1):
            old, new = (edit.get("old"), edit.get("new")) if isinstance(edit, dict) else (None, None)
            if not isinstance(old, str) or not old or not isinstance(new, str):
                raise ToolError(f"Edit {number} needs 'old' and 'new' strings. Nothing was changed.")
            count = script.count(old)
            if count == 0:
                raise ToolError(f"Edit {number}: 'old' was not found in the script as it stands after the "
                                "edits before it. Nothing was changed.")
            if count > 1 and edit.get("replace_all") is not True:
                raise ToolError(f"Edit {number}: 'old' matches {count} places; add surrounding text to make "
                                "it unique or set replace_all. Nothing was changed.")
            script = script.replace(old, new)
        return script

    def _look_up(self, arguments: dict) -> str:
        parts, search = arguments.get("parts") or [], arguments.get("search")
        if not isinstance(parts, list) or len(parts) > 12 or (not parts and not search):
            raise ToolError("Give up to 12 part ids in 'parts', a 'search' phrase, or both")
        found = [self._toolbox.call("inspect_part", {"part": part}).text for part in parts]
        if search:
            found.append(f"Search '{search}':\n" + self._toolbox.call(
                "search_parts", {"query": search, "limit": 20}).text)
        facts = self._state["facts"] + found
        while len(facts) > 1 and sum(map(len, facts)) > MAX_FACTS:
            facts.pop(0)
        self._state["facts"] = facts
        return f"Looked up {len(found)} item{'s' if len(found) != 1 else ''}; the facts are listed above."

    def _act(self, name: str, arguments: dict) -> Outcome:
        """Carry out one action; the outcome is what the model is told at the start of the next round."""
        self._remember(arguments)
        try:
            if name == "build":
                code = arguments.get("code")
                if not isinstance(code, str) or not code.strip():
                    raise ToolError("'code' must be the whole build script")
                return self._rebuild(code, self._views(arguments))
            if name == "patch":
                return self._rebuild(self._patched(arguments.get("edits")), self._views(arguments))
            if name == "look_up":
                return Outcome(self._look_up(arguments))
            if name == "finish":
                done = self._toolbox.call("finish", arguments)
                return Outcome(done.text, failed=done.is_error, finished=done.finished)
        except ToolError as exc:
            return Outcome(f"ERROR: {exc}", failed=True)
        return Outcome(f"ERROR: unknown action {name!r}. Use build, patch, look_up or finish.", failed=True)

    # ----- the loop -------------------------------------------------------

    def run(self, content: list[dict]) -> RunResult:
        """Add a request (a new build or a follow-up change) and work on it for a few rounds."""
        session, state = self._session, self._state
        published_before = len(session.meta["published"])
        session.meta["status"] = "running"
        state["brief"] = state["brief"] + content
        state["outcome"] = "A new request was added to the brief above." if published_before else ""
        session.save()
        reason = "round limit reached"
        rounds = 0
        while rounds < self._max_rounds:
            request = self._request(rounds + 1)
            try:
                # Nothing is carried over from the last round, so only this request is reserved.
                allowance = self._budget.output_allowance(
                    estimate_tokens(request) + estimate_tokens(session.meta["system"]), self._max_tokens,
                    carried_context=False)
            except BudgetExhausted:
                reason = "AI budget used up"
                break
            sent = session.inflate(self._with_cache_point(request, len(state["brief"])))
            reply = self._client.send(session.meta["system"], session.meta["tools"],
                                      [{"role": "user", "content": sent}], max_tokens=allowance,
                                      on_delta=lambda kind, text: self._emit(kind, {"text": text}))
            rounds += 1
            self._budget.record(reply)
            session.meta["usage"] = session.meta.get("usage", []) + self._budget.calls[-1:]
            self._emit("turn", {"step": rounds, "spent_usd": str(self._budget.spent)})
            if reply.stop_reason == "refusal":
                session.save()
                return close_run(session, self._toolbox, self._budget, self._emit, "refused",
                                 "the model declined the request", rounds, published_before)
            # The transcript is a record of each round here; it is never sent back to the model.
            session.append("user", request)
            session.append("assistant", reply.content)
            calls = [block for block in reply.content if block.get("type") == "tool_use"]
            if reply.stop_reason == "max_tokens":
                state["outcome"] = CUT_OFF
            elif not calls:
                state["outcome"] = NO_ACTION
            elif calls[0].get("id") in reply.invalid_inputs:
                state["outcome"] = BAD_INPUT
            else:
                call = calls[0]
                self._emit("tool_call", {"name": call.get("name"), "input": call.get("input")})
                outcome = self._act(call.get("name"), call.get("input") or {})
                state["outcome"] = outcome.text
                self._emit("tool_result", {"name": call.get("name"), "text": outcome.text,
                                           "is_error": outcome.failed, "images": list(state["views"])})
                if outcome.finished:
                    return close_run(session, self._toolbox, self._budget, self._emit, "published", "finished",
                                     rounds, published_before)
            session.save()
        return close_run(session, self._toolbox, self._budget, self._emit, None, reason, rounds, published_before)
