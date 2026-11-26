"""What a v2 build must also pass before it is published.

The rules began as Nova's publication checks and now belong to the Fable agents. Three reviews
run after the ordinary checks and add to the same report:

* solid plastic that intersects, which no script can declare intended (``material``);
* joints that can be measured without being told: from connector data where a part has it
  (``connectors``), from its shape otherwise (``fits``); parts that sit on each other without
  fitting; Technic pins and axles that are not seated (``toolkit``); and declared joints that
  have no evidence (``joints``);
* vehicles: wheels that do not stand on one road or have no room to turn, and planes and boats
  that are not mirror images (``vehicle``); errors only where the request is a wheeled vehicle;
* a building order of small connected steps (``sequence``), kept on the report for the
  instructions.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from .checks import MAX_LISTED, Issue, Report, StudContact
from .connectors import ConnectorFindings, ConnectorReview
from .fits import FitFinder, around_a_fit
from .joints import JointReview
from .kit import Build
from .ldraw import LDrawLibrary
from .material import MaterialReview
from .sequence import NoSequence, SequencePlanner
from .shape import ShapeLibrary
from .vehicle import WheelReview

Label = Callable[[int], str]


@dataclass
class Measured:
    """The joints of one build that were found without being declared."""

    fits: set[tuple[int, int]] = field(default_factory=set)  # joined pairs, lower placement first
    refuted: dict[tuple[int, int], str] = field(default_factory=dict)  # looked joined by shape; the data says why not
    by_data: int = 0  # joints the connector data confirmed
    connectors: ConnectorFindings = field(default_factory=ConnectorFindings)


class AssemblyReview:
    def __init__(self, library: LDrawLibrary, shapes: ShapeLibrary, connectors: ConnectorReview | None = None,
                 vehicle: str | None = None):
        self._material = MaterialReview(library, shapes)
        self._fits = FitFinder(library)
        self._connectors = connectors
        self._joints = JointReview(library, shapes)
        self._sequence = SequencePlanner(shapes)
        self._wheels = WheelReview(library)
        self._vehicle = vehicle  # what the request is about (see ``vehicle.vehicle_kind``)

    def measure(self, placements) -> Measured:
        """Pairs of placements where a connector of one is seated in a connector of the other.

        Connector data decides wherever both parts have it. A pair that only looks seated by its
        shape, and whose connectors do not fit each other, is not joined; the reason is kept.
        """
        shaped = self._fits.find(placements)
        found = self._connectors.review(placements) if self._connectors is not None else ConnectorFindings()
        refuted = {}
        for pair in shaped - found.joints:
            reason = found.misfit(*pair)
            if reason is not None:
                refuted[pair] = reason
        return Measured((shaped - set(refuted)) | found.joints, refuted, len(found.joints), found)

    def fits(self, placements) -> set[tuple[int, int]]:
        """The joined pairs of ``measure``."""
        return self.measure(placements).fits

    @staticmethod
    def seated(fits: set[tuple[int, int]]) -> set[tuple[int, int]]:
        """The pairs whose coarse shapes may share space because of a measured joint."""
        return around_a_fit(fits)

    def review(self, build: Build, boxes: dict[int, list], contacts: list[StudContact],
               measured: Measured | set[tuple[int, int]], report: Report, label: Label) -> None:
        if not isinstance(measured, Measured):
            measured = Measured(set(measured))
        fits = measured.fits
        if fits:
            report.notes.append(f"{len(fits)} joints were measured ({measured.by_data} from connector data): a pin, "
                                "bar, hinge, axle, tyre or pane of one part seated in another. They need no connect().")
        if measured.connectors.skipped:
            report.notes.append("Connector data was not used on this build, so joints were measured from the "
                                f"parts' shapes only ({measured.connectors.skipped}).")
        if measured.connectors.technic_unchecked:
            report.notes.append(f"The build has {measured.connectors.technic_unchecked} measured Technic parts, more "
                                "than are reviewed at once: whether their pins and axles are seated was not checked.")
        if measured.connectors.unreviewed:
            report.notes.append(f"{measured.connectors.unreviewed} Technic part(s) are a different release of the "
                                "part than the one whose holes were measured; their joints were measured from "
                                "their shape only.")
        self._review_material(build, report, label)
        studded = {frozenset((c.stud, c.receiver)) for c in contacts}
        self._review_misfits(measured, studded, report, label)
        self._review_technic(measured, report, label)
        self._review_joints(build, boxes, studded, measured, report, label)
        for finding in self._wheels.review(build.placements, boxes, fits, label, self._vehicle):
            (report.errors if finding.error else report.warnings).append(
                Issue("vehicle", finding.message, finding.placements))
        self._require_one_model(report)
        if report.ok:
            self._plan(build, boxes, contacts, fits, report, label, measured.connectors.shafts)

    def _review_material(self, build: Build, report: Report, label: Label) -> None:
        pairs = self._material.collisions(build.placements)
        for first, second in pairs[:MAX_LISTED]:
            report.errors.append(Issue(
                "material", f"{label(first)} and {label(second)} are solid plastic in the same place. "
                            "allow_overlap does not cover this: move, turn or replace one of them.", (first, second)))
        if len(pairs) > MAX_LISTED:
            report.errors.append(Issue("material", f"{len(pairs) - MAX_LISTED} more pairs of parts are solid "
                                                   "plastic in the same place."))

    @staticmethod
    def _review_misfits(measured: Measured, studded: set[frozenset[int]], report: Report, label: Label) -> None:
        """Parts that sit where a joint would be, and are held by nothing else, but do not fit."""
        misfits = dict(measured.refuted)
        misfits.update({(first, second): reason for first, second, reason in measured.connectors.unseated()})
        wrong = [(pair, reason) for pair, reason in sorted(misfits.items()) if frozenset(pair) not in studded]
        for (first, second), reason in wrong[:MAX_LISTED]:
            report.errors.append(Issue(
                "fit", f"{label(first)} sits on {label(second)} but does not fit it: {reason}. Use the part made "
                       "for it (the right tyre for the rim, the right pane for the frame) or seat it.",
                (first, second)))
        if len(wrong) > MAX_LISTED:
            report.errors.append(Issue("fit", f"{len(wrong) - MAX_LISTED} more pairs of parts sit on each other "
                                              "without fitting."))

    @staticmethod
    def _review_technic(measured: Measured, report: Report, label: Label) -> None:
        found = measured.connectors
        errors = [item for item in found.technic if item.error]
        for item in errors[:MAX_LISTED]:
            parts = " and ".join(label(index) for index in item.placements[:3])
            report.errors.append(Issue("technic", f"{parts}: {item.message} [{item.code}]", item.placements))
        if len(errors) > MAX_LISTED:
            report.errors.append(Issue("technic", f"{len(errors) - MAX_LISTED} more Technic joints are not seated."))
        # An axle is held by whatever is fixed on it. The registry knows bushes; a wheel or a gear it
        # has not measured holds an axle too, so an axle that carries one is not called loose.
        carried = {index for pair in measured.fits for index in pair
                   if not found.is_measured_technic(pair[0]) or not found.is_measured_technic(pair[1])}
        advice = [item for item in found.technic if not item.error
                  and not (item.code == "technic.axial_retention" and set(item.placements) & carried)]
        for item in advice[:MAX_LISTED]:
            parts = " and ".join(label(index) for index in item.placements[:3])
            report.warnings.append(Issue("technic", f"{parts}: {item.message} [{item.code}]", item.placements))

    def _review_joints(self, build: Build, boxes, studded, measured: Measured, report: Report, label: Label) -> None:
        if not build.links:
            return
        fits = measured.fits
        found = self._joints.review(build, boxes, studded, fits, measured.connectors.misfit)
        for first, second, note, reason in found.wrong[:MAX_LISTED]:
            report.errors.append(Issue(
                "joint", f"connect() joins {label(first)} to {label(second)} ({note or 'no note'}), but they do not "
                         f"fit: {reason}. Use the part made for it or seat it.", (first, second)))
        for first, second, note in found.apart[:MAX_LISTED]:
            report.errors.append(Issue(
                "joint", f"connect() joins {label(first)} to {label(second)} ({note or 'no note'}), but they do "
                         "not touch. Move them together or attach them with studs.", (first, second)))
        for first, second, note in found.missed[:MAX_LISTED]:
            report.errors.append(Issue(
                "joint", f"connect() joins {label(first)} to {label(second)} ({note or 'no note'}), but the pin "
                         "or axle is in none of the other part's holes. Line it up with a hole.", (first, second)))
        hidden = sum(max(0, len(group) - MAX_LISTED) for group in (found.apart, found.missed, found.wrong))
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

    def _plan(self, build: Build, boxes, contacts, fits, report: Report, label: Label, shafts=None) -> None:
        try:
            report.plan = (self._sequence.plan(build, contacts, boxes, fits, shafts) if shafts
                           else self._sequence.plan(build, contacts, boxes, fits))
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
