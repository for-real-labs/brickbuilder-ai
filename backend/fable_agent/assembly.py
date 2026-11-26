"""What a v2 build must also pass before it is published.

The rules began as Nova's publication checks and now belong to the Fable agents. Three reviews
run after the ordinary checks and add to the same report:

* solid plastic that intersects, which no script can declare intended (``material``);
* joints that can be measured without being told (``fits``), and declared joints that have no
  evidence (``joints``);
* a building order of small connected steps (``sequence``), kept on the report for the
  instructions.
"""

from __future__ import annotations

from collections.abc import Callable

from .checks import MAX_LISTED, Issue, Report, StudContact
from .fits import FitFinder, around_a_fit
from .joints import JointReview
from .kit import Build
from .ldraw import LDrawLibrary
from .material import MaterialReview
from .sequence import NoSequence, SequencePlanner
from .shape import ShapeLibrary

Label = Callable[[int], str]


class AssemblyReview:
    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary):
        self._material = MaterialReview(library, shapes)
        self._fits = FitFinder(library)
        self._joints = JointReview(library, shapes)
        self._sequence = SequencePlanner(shapes)

    def fits(self, placements) -> set[tuple[int, int]]:
        """Pairs of placements where a peg, pin, bar or axle of one sits in a hole or clip of the other."""
        return self._fits.find(placements)

    @staticmethod
    def seated(fits: set[tuple[int, int]]) -> set[tuple[int, int]]:
        """The pairs whose coarse shapes may share space because of a measured joint."""
        return around_a_fit(fits)

    def review(self, build: Build, boxes: dict[int, list], contacts: list[StudContact], fits: set[tuple[int, int]],
               report: Report, label: Label) -> None:
        if fits:
            report.notes.append(f"{len(fits)} joints were measured: a pin, bar, hinge pin or axle of one part "
                                "inside a hole or clip of another. They need no connect().")
        self._review_material(build, report, label)
        self._review_joints(build, boxes, contacts, fits, report, label)
        self._require_one_model(report)
        if report.ok:
            self._plan(build, boxes, contacts, fits, report, label)

    def _review_material(self, build: Build, report: Report, label: Label) -> None:
        pairs = self._material.collisions(build.placements)
        for first, second in pairs[:MAX_LISTED]:
            report.errors.append(Issue(
                "material", f"{label(first)} and {label(second)} are solid plastic in the same place. "
                            "allow_overlap does not cover this: move, turn or replace one of them.", (first, second)))
        if len(pairs) > MAX_LISTED:
            report.errors.append(Issue("material", f"{len(pairs) - MAX_LISTED} more pairs of parts are solid "
                                                   "plastic in the same place."))

    def _review_joints(self, build: Build, boxes, contacts, fits, report: Report, label: Label) -> None:
        if not build.links:
            return
        found = self._joints.review(build, boxes, {frozenset((c.stud, c.receiver)) for c in contacts}, fits)
        for first, second, note in found.apart[:MAX_LISTED]:
            report.errors.append(Issue(
                "joint", f"connect() joins {label(first)} to {label(second)} ({note or 'no note'}), but they do "
                         "not touch. Move them together or attach them with studs.", (first, second)))
        for first, second, note in found.missed[:MAX_LISTED]:
            report.errors.append(Issue(
                "joint", f"connect() joins {label(first)} to {label(second)} ({note or 'no note'}), but the pin "
                         "or axle is in none of the other part's holes. Line it up with a hole.", (first, second)))
        hidden = len(found.apart) + len(found.missed) - min(len(found.apart), MAX_LISTED) - min(len(found.missed),
                                                                                                 MAX_LISTED)
        if hidden > 0:
            report.errors.append(Issue("joint", f"{hidden} more declared joints have no evidence."))
        report.notes.append(f"{len(build.links)} declared joints: {found.seated} measured as one part seated in "
                            f"the other, {found.touching} others checked only for touching.")

    @staticmethod
    def _require_one_model(report: Report) -> None:
        """A model is one connected piece; free-standing pieces cannot share a building order."""
        separate = [issue for issue in report.warnings if issue.kind == "separate"]
        report.warnings[:] = [issue for issue in report.warnings if issue.kind != "separate"]
        report.errors += [Issue(issue.kind, issue.message.replace(" unless they are meant to be separate", "")
                                + " One connected model is needed for building instructions.", issue.placements)
                          for issue in separate]

    def _plan(self, build: Build, boxes, contacts, fits, report: Report, label: Label) -> None:
        try:
            report.plan = self._sequence.plan(build, contacts, boxes, fits)
        except NoSequence as exc:
            sample = "; ".join(label(index) for index in exc.remaining[:4])
            more = f" and {len(exc.remaining) - 4} more" if len(exc.remaining) > 4 else ""
            where = f": {sample}{more}" if sample else ""
            report.errors.append(Issue(
                "sequence", f"No building order adds every piece ({exc}){where}. Each piece must attach to "
                            "something already built, and must not be closed in between two pieces before it "
                            "is placed.", tuple(exc.remaining[:MAX_LISTED])))
            return
        report.notes.append(f"Instructions: {report.plan.step_count} steps of at most 5 connected pieces, "
                            "ordered from the ground up.")
