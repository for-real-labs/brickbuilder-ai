"""Joints measured from connector data: which part fits which, and whether it is seated.

Pip's own copy of the LDCad shadow library (``data/shadow``) names the connectors of about 4,600
parts: studs, bars and clips, pins and axles with their holes, hinge fingers, the seat of a rim
for its tyre and of a frame for its pane. ``pyldraw3`` reads them, and the Technic registry in
``toolkit`` replaces them on the Technic parts whose holes were measured by hand.

Two parts are joined here when a connector of one is seated in a matching connector of the
other. When both parts have connectors of the same family and none is seated, the pair is a
misfit: a tyre on a rim of another size, a pane in a frame it was not made for. Only seats are
judged that way, and only from connectors someone wrote down for the part. A part without them
proves nothing either way and is left to the measurements in ``fits``. Technic pins and axles
are judged by the registry of measured parts in ``toolkit``.

Studs are not judged here; the checker measures those itself on every part.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from functools import cached_property
from pathlib import Path

import numpy as np

from .kit import Placement

SHADOW = Path(__file__).parent / "data" / "shadow"
INSIDE = 1.0  # LDU two parts' bounds must share on every axis before one is said to sit in the other
SEATED = 2.0  # LDU between two seat connectors that still counts as seated: model files round to this
RIM_PLAY = 1.0  # LDU a rim's seat may differ from the rims a tyre is sold on
AXLE_RADIUS = 6.0  # LDU
ON_LINE = 0.5  # LDU a hole's centre may be off the line of the axle through it
# The seating review compares every measured Technic part with every other. 300 take about three
# seconds; past that a build is told its Technic seating was not reviewed.
TECHNIC_LIMIT = 300


@dataclass(frozen=True)
class TechnicFinding:
    code: str  # the toolkit's name for it, such as ``technic.invalid_seating``
    message: str
    placements: tuple[int, ...]
    error: bool


@dataclass
class ConnectorFindings:
    """What the connector data says about one build."""

    joints: set[tuple[int, int]] = field(default_factory=set)  # lower placement first
    technic: list[TechnicFinding] = field(default_factory=list)
    reviewed: int = 0  # placements that have a connector other than a stud
    unreviewed: int = 0  # Technic placements whose geometry is not the one their connectors were measured on
    technic_unchecked: int = 0  # measured Technic placements, when there are too many to review their seating
    skipped: str = ""  # why nothing was measured, when nothing was
    # What sits on each measured axle: axle -> (place along the axle in LDU, the part there).
    shafts: dict[int, list[tuple[float, int]]] = field(default_factory=dict)
    _features: dict[int, tuple] = field(default_factory=dict, repr=False)
    _bounds: dict[int, tuple] = field(default_factory=dict, repr=False)  # low and high corner, model space
    _library: ConnectorLibrary | None = field(default=None, repr=False)  # to look up the rims a tyre is sold on

    def misfit(self, first: int, second: int) -> str | None:
        """Why two placements that are not joined cannot be, or None when the data cannot say.

        Only seats are judged: a tyre on a rim, and a part made to nest in another (a pane in a
        frame). A pin, bar or axle beside a hole it could fit is left to the other checks, because
        the data's cylinders are not exact enough to prove that two of them do not mate.
        """
        pair = (min(first, second), max(first, second))
        if pair in self.joints or first not in self._features or second not in self._features:
            return None
        reasons = []
        for a in self._features[first]:
            for b in self._features[second]:
                verdict = self._judge(a, b)
                if verdict == "":
                    return None  # one seat of theirs fits and is taken
                if verdict:
                    reasons.append(verdict)
        # "Not seated" says more than "wrong size" when both were found.
        return min(reasons, key=lambda reason: reason.startswith("no ")) if reasons else None

    def _judge(self, a, b) -> str | None:
        """"" when the two connectors fit and are seated, a reason when they are not, None when unknown."""
        from ldraw.connection_types import ConnectionKind as Kind, connections_compatible
        kinds = {a.kind, b.kind}
        if kinds == {Kind.GENERIC}:
            if not (_authored(a) and _authored(b)):
                return None
            fits = connections_compatible(a, b)
        elif kinds == {Kind.RIM_SEAT, Kind.TYRE_BEAD}:
            rim, tyre = (a, b) if a.kind is Kind.RIM_SEAT else (b, a)
            fits = self._tyre_fits(rim, tyre)
            if fits is None:
                return None
        else:
            return None
        if not fits:
            return "no seat of one is the size or kind the other was made for"
        shift = a.position - b.position
        if abs(shift) <= SEATED and abs(a.axis.dot(b.axis)) > 0.999:
            return ""
        if abs(shift) <= SEATED:
            return "they fit each other but are not turned the same way: give both the same rotation"
        return (f"they fit each other but the second is {abs(shift):.1f} LDU off its seat: move it by "
                f"({shift.x:+.1f}, {shift.y:+.1f}, {shift.z:+.1f}) LDU in x, y, z (y points down)")

    def _tyre_fits(self, rim, tyre) -> bool | None:
        """Whether a tyre is the size of a rim's seat.

        The data lists, for a tyre, the rims it is sold on. It fits any rim whose seat is the size
        of one of those, not only the listed ones. None when the tyre is on no list.
        """
        if rim.owner_code and rim.owner_code.casefold() in {code.casefold() for code in tyre.compatible_parts}:
            return True
        if tyre.owner_code and tyre.owner_code.casefold() in {code.casefold() for code in rim.compatible_parts}:
            return True
        sizes = [seat for code in tyre.compatible_parts for seat in self._rim_seats(code)]
        if not sizes:
            return None
        return any(abs(radius - rim.profile.radius) <= RIM_PLAY for radius in sizes)

    def _rim_seats(self, part: str) -> list[float]:
        from ldraw.connection_types import ConnectionKind as Kind
        local = self._library.local(part) if self._library is not None else None
        return [feature.profile.radius for feature in (local[1] if local else ()) if feature.kind is Kind.RIM_SEAT]

    def unseated(self) -> list[tuple[int, int, str]]:
        """Parts made for one seat, a tyre or a pane, that sit inside a part they do not fit."""
        from ldraw.connection_types import ConnectionKind as Kind
        seats = (Kind.GENERIC, Kind.RIM_SEAT, Kind.TYRE_BEAD)
        seated = {index for pair in self.joints for index in pair}
        own = sorted(index for index, features in self._features.items() if any(f.kind in seats for f in features))
        found = []
        for slot, first in enumerate(own):
            for second in own[slot + 1:]:
                low = np.maximum(self._bounds[first][0], self._bounds[second][0])
                high = np.minimum(self._bounds[first][1], self._bounds[second][1])
                if np.any(high - low <= INSIDE):
                    continue
                insert = min(first, second, key=lambda index: float(np.prod(self._bounds[index][1]
                                                                            - self._bounds[index][0])))
                reason = None if insert in seated else self.misfit(first, second)
                if reason is not None:
                    found.append((first, second, reason))
        return found

    def is_measured_technic(self, index: int) -> bool:
        """Whether a placement is a Technic part whose connectors come from the registry."""
        from .toolkit.technic import managed
        return any(managed(feature) for feature in self._features.get(index, ()))


def _authored(feature) -> bool:
    """Written down by a person for this part, not inferred from its outline."""
    from ldraw.connection_types import ConnectionSource as Source
    return feature.source is not Source.HEURISTIC


class ConnectorLibrary:
    """The parts library as ``pyldraw3`` sees it, with Pip's connector data attached."""

    def __init__(self, ldraw_root: Path | str, cache_dir: Path | str, shadow: Path = SHADOW):
        self.root = Path(ldraw_root)
        self._cache = Path(cache_dir) / "connectors"
        self.shadow = shadow
        self._local: dict[str, tuple | None] = {}

    @cached_property
    def parts(self):
        from .toolkit.common import get_parts
        return get_parts(self.root, self._cache, [self.shadow] if self.shadow.is_dir() else [])

    def local(self, part: str) -> tuple | None:
        """A part's geometry, its connectors other than studs, and its bounds as centre and half size.

        None for a part that cannot be read or has no such connector.
        """
        if part not in self._local:
            self._local[part] = self._read(part)
        return self._local[part]

    def _read(self, part: str) -> tuple | None:
        from ldraw.connection_types import ConnectionKind as Kind
        from .toolkit.technic import definition
        parts = self.parts  # a library that cannot be opened is an error for the whole review, not for one part
        try:
            geometry = parts.geometry(part)
        except Exception:  # a part pyldraw3 cannot expand has no connector data to offer
            return None
        if geometry.bounds is None:
            return None
        features = tuple(f for f in geometry.connections if f.kind not in (Kind.STUD, Kind.STUD_RECEPTACLE))
        if not features and definition(geometry) is None:
            return None
        low = np.array([geometry.bounds.min.x, geometry.bounds.min.y, geometry.bounds.min.z])
        high = np.array([geometry.bounds.max.x, geometry.bounds.max.y, geometry.bounds.max.z])
        return geometry, features, (low + high) / 2, (high - low) / 2


class ConnectorReview:
    def __init__(self, library: ConnectorLibrary):
        self._library = library

    def review(self, placements: list[Placement]) -> ConnectorFindings:
        """Never raises: a build the connector data cannot read is measured the old way."""
        try:
            return self._review(placements)
        except Exception as exc:  # third-party parsing of a third-party library
            return ConnectorFindings(skipped=f"{type(exc).__name__}: {exc}"[:200])

    def _review(self, placements: list[Placement]) -> ConnectorFindings:
        from ldraw.connection_types import ConnectionKind as Kind
        from .toolkit.connection_adapter import connection_contacts
        from .toolkit.technic import canonical, curate, definition, endpoints, managed, registry

        inspection = self._inspection(placements)
        if inspection is None:
            return ConnectorFindings()
        inspection = curate(inspection)
        findings = ConnectorFindings(reviewed=len(inspection.occurrences), _library=self._library)
        findings._features = {item.index: item.connections for item in inspection.occurrences}
        findings._bounds = {item.index: (np.array([item.bounds.min.x, item.bounds.min.y, item.bounds.min.z]),
                                         np.array([item.bounds.max.x, item.bounds.max.y, item.bounds.max.z]))
                            for item in inspection.occurrences}
        studs = (Kind.STUD, Kind.STUD_RECEPTACLE)
        for contact in connection_contacts(inspection):
            if contact.first.kind in studs or contact.second.kind in studs:
                continue
            a, b = contact.first_occurrence.index, contact.second_occurrence.index
            findings.joints.add((min(a, b), max(a, b)))
            if managed(contact.first) and managed(contact.second):
                male, shaft, receiver, hole = endpoints(contact)
                if shaft.kind is Kind.AXLE:  # a measured part seated on a measured axle
                    findings.shafts.setdefault(male.index, []).append((float(hole.position.dot(shaft.axis)),
                                                                        receiver.index))
        measured = sum(1 for item in inspection.occurrences if any(managed(f) for f in item.connections))
        if measured > TECHNIC_LIMIT:
            findings.technic_unchecked = measured
        elif measured:
            findings.technic = self._technic(inspection)
            for axle, other, station in self._on_measured_axles(inspection):
                findings.joints.add((min(axle, other), max(axle, other)))
                findings.shafts.setdefault(axle, []).append((station, other))
        findings.unreviewed = sum(
            1 for item in inspection.occurrences
            if canonical(item.local.code) in registry()["parts"] and definition(item.local) is None)
        return findings

    def _inspection(self, placements: list[Placement]):
        """``pyldraw3``'s inspection of the placements that have a connector other than a stud.

        Built here instead of by ``inspect_model``, which measures every point of every part and
        every stud: on a model of plain bricks that is most of the work and none of the answer.
        Each occurrence keeps its placement's index.
        """
        from ldraw import Vector, parse_model_result
        from ldraw.inspection import ModelInspection, OccurrenceAttribution, OccurrenceGeometry
        from ldraw.part_geometry_types import BoundingBox

        chosen = [index for index, placement in enumerate(placements) if self._library.local(placement.part)]
        if not chosen:
            return None
        lines = [f"1 {p.color} " + " ".join(f"{v:.6f}".rstrip("0").rstrip(".") for v in (*p.position, *p.matrix))
                 + f" {p.part}.dat" for p in (placements[index] for index in chosen)]
        parsed = parse_model_result("\n".join(lines) + "\n", name="pip-connectors.ldr", source="pip-connectors.ldr",
                                    parts=self._library.parts)
        occurrences = list(parsed.model.iter_occurrences(include_steps=True)) if parsed.model else []
        if len(occurrences) != len(chosen):
            raise ValueError("the placements could not be read as a model")
        items = []
        for index, occurrence in zip(chosen, occurrences):
            geometry, features, centre, half = self._library.local(placements[index].part)
            matrix = np.array(occurrence.matrix.rows, dtype=float)
            middle = matrix @ centre + np.array([occurrence.position.x, occurrence.position.y, occurrence.position.z])
            reach = np.abs(matrix) @ half
            path = occurrence.path
            items.append(OccurrenceGeometry(
                attribution=OccurrenceAttribution(
                    index=index, occurrence=occurrence,
                    model_path=tuple(hop.model.name for hop in path),
                    reference_path=tuple(hop.piece.reference for hop in path),
                    source_line_path=tuple(hop.source_line for hop in path),
                    local_step_path=tuple(hop.local_step for hop in path),
                    effective_step_path=tuple(hop.effective_step for hop in path),
                    page_path=tuple(None for _ in path)),
                local=geometry, bounds=BoundingBox(Vector(*(middle - reach)), Vector(*(middle + reach))), studs=(),
                connections=tuple(f.transformed(position=occurrence.position, matrix=occurrence.matrix)
                                  for f in features)))
        return ModelInspection(bounds=None, occurrences=tuple(items), skipped_geometry=(), diagnostics=(),
                               occurrence_count=len(items))

    @staticmethod
    def _on_measured_axles(inspection) -> list[tuple[int, int, float]]:
        """Parts the registry has not measured (a wheel, a gear) that a measured axle passes through.

        The registry joins a measured axle only to measured holes, so a wheel on an axle would be
        joined to nothing. It is joined here when the axle's line runs through an axle hole or pin
        hole the connector data names, inside the axle's length. Each is given as the axle, the
        part, and where along the axle the part's hole is.
        """
        from ldraw.connection_types import ConnectionKind as Kind, CylindricalProfile
        from .toolkit.technic import managed
        axles = [(item.index, f) for item in inspection.occurrences for f in item.connections
                 if managed(f) and f.kind is Kind.AXLE]
        holes = [(item.index, f) for item in inspection.occurrences for f in item.connections
                 if not managed(f) and f.kind in (Kind.AXLE_HOLE, Kind.PIN_HOLE) and _authored(f)
                 and isinstance(f.profile, CylindricalProfile)
                 and any(abs(section.radius - AXLE_RADIUS) <= 0.5 for section in f.profile.sections)]
        found: dict[tuple[int, int], float] = {}
        for owner, axle in axles:
            for other, hole in holes:
                if other == owner or abs(axle.axis.dot(hole.axis)) < 0.999:
                    continue
                apart = hole.position - axle.position
                along = apart.dot(axle.axis)
                if abs(along) <= axle.length / 2 and abs(apart - axle.axis * along) <= ON_LINE:
                    found.setdefault((owner, other), float(hole.position.dot(axle.axis)))
        return [(axle, other, station) for (axle, other), station in found.items()]

    @staticmethod
    def _technic(inspection) -> list[TechnicFinding]:
        from .toolkit.technic_review import review_inspection
        advisory = {"technic.axial_retention", "technic.bearing_rotation", "technic.pivot_support",
                    "technic.unbraced_loop"}
        found = []
        for item in review_inspection(inspection)["diagnostics"]:
            error = item["severity"] == "error" and item["code"] != "technic.mechanism_scope"
            if not error and item["code"] not in advisory:
                continue
            detail = ""
            if item.get("short_shafts_ldu"):
                shaft = item["short_shafts_ldu"][0]
                detail = (f" The axle is {shaft['shaft_length']:g} LDU long and needs at least "
                          f"{shaft['minimum_centered_span']:g} to pass through this hole.")
            found.append(TechnicFinding(item["code"], item["message"] + detail, tuple(item["instances"]), error))
        return found


def joined_through(joints: set[tuple[int, int]]) -> dict[int, set[int]]:
    partners: dict[int, set[int]] = defaultdict(set)
    for first, second in joints:
        partners[first].add(second)
        partners[second].add(first)
    return partners
