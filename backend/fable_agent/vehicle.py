"""Vehicles reviewed for what makes them one: wheels that stand and turn, wings and hulls that match.

The wheel rules are the toolkit's vehicle review (``toolkit/vehicle_review``). This module measures
a build for it: where each tyre is and how large, what reaches lower than the tyres, and what
stands in the space a tyre turns in, measured on the parts' real surfaces.

What the request asks for decides how strict the review is (``vehicle_kind``). For a car, truck or
other wheeled vehicle, a tyre off the ground and bodywork below the tyres are errors. For anything
else they are warnings, so a cart with one axle or a car on a display base is not refused. A plane
or a boat is also checked for being a mirror image left to right, as a warning: a detail on one
side is fine, a wing or a hull side that is missing is not.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .kit import Placement
from .ldraw import LDrawError, LDrawLibrary

COARSE = 2.0  # LDU: a quarter of a plate, the accuracy of the coarse shapes the measurements come from
GROUND_CONTACT = 6.0  # LDU above a tyre's lowest point where what it stands on may reach
GROUND_LAYER = 24.0  # LDU: a plane or boat's display base or water is not part of its shape
MIRROR_PLAY = 6.0  # LDU a part may be off the mirror image of another and still match it
UNMATCHED = 0.2  # of a plane or boat's volume that may have no mirror image before it is reported
KINDS = {  # what a request is about, by the first of these words it uses
    "road": r"cars?|trucks?|jeeps?|vans?|bus|buses|pickups?|tractors?|lorr(?:y|ies)|taxis?|ambulances?|limos?|"
            r"limousines?|buggy|buggies|karts?|race ?cars?|fire ?engines?|fire ?trucks?|suvs?|sedans?|coupes?|"
            r"trailers?|bulldozers?|excavators?|diggers?|forklifts?|campers?|caravans?|rovers?|wagons?",
    "motorcycle": r"motorcycles?|motorbikes?|scooters?|mopeds?|dirt ?bikes?|bicycles?|bikes?",
    "aircraft": r"planes?|airplanes?|aeroplanes?|aircraft|jets?|airliners?|biplanes?|seaplanes?|gliders?|"
                r"fighter ?jets?|bombers?|drones?",
    "boat": r"boats?|ships?|yachts?|tugs?|tugboats?|ferr(?:y|ies)|sailboats?|canoes?|kayaks?|submarines?|"
            r"steamboats?|galleons?|catamarans?|speedboats?|rafts?",
}
STRICT = {"vehicle.ground_contact", "vehicle.below_road"}  # errors when the request is a wheeled vehicle
MESSAGES = {
    "vehicle.ground_contact": "{0} is a tyre that does not stand on the ground the other tyres stand on "
                              "(off by {ground_error_ldu:.0f} LDU). Put every axle at a height that suits its tyre.",
    "vehicle.below_road": "{0} reaches {below_ldu:.0f} LDU below the tyres ({count} such part(s)), so the model "
                          "would rest on it and not on its wheels. Raise it or lower the axles.",
    "vehicle.axle_pair": "The wheels at one axle are not a left and right pair: {0}.",
    "vehicle.axle_symmetry": "{0} and {1} are one axle but are not mirror images: different height, size or "
                             "distance from the middle of the vehicle.",
    "vehicle.motorcycle_wheel": "{0} is off the centre line the other wheel of this two-wheeler is on.",
    "vehicle.wheel_space": "{1} is inside the space {0} turns in ({intrusion:.0f} LDU into it). Leave room "
                           "around each tyre: raise the part, move it out, or build a wheel arch.",
    "vehicle.symmetry": "The {kind} is not a mirror image left to right: {share:.0%} of it has no counterpart on "
                        "the other side, the largest being {parts}. Wings, engines and hull sides should match.",
}


def vehicle_kind(request: str | None) -> str | None:
    """"road", "motorcycle", "aircraft" or "boat" when the request names such a vehicle, else None.

    The first vehicle word decides: "a truck carrying a boat" is a road vehicle.
    """
    if not request:
        return None
    found = []
    for kind, words in KINDS.items():
        match = re.search(rf"\b(?:{words})\b", request, re.IGNORECASE)
        if match:
            found.append((match.start(), kind))
    return min(found)[1] if found else None


@dataclass(frozen=True)
class WheelFinding:
    code: str
    message: str
    placements: tuple[int, ...]
    error: bool = False


class WheelReview:
    def __init__(self, library: LDrawLibrary):
        self._library = library
        self._tyres: dict[str, tuple | None] = {}

    def review(self, placements: list[Placement], boxes: dict[int, list], fits: set[tuple[int, int]],
               label: Callable[[int], str], kind: str | None = None) -> list[WheelFinding]:
        """``kind`` is what the request is about (see ``vehicle_kind``); None for anything else."""
        findings = self._wheels(placements, boxes, fits, label, strict=kind in ("road", "motorcycle"))
        if kind in ("aircraft", "boat"):
            findings += self._symmetry(placements, boxes, label, kind)
        return findings

    def _wheels(self, placements, boxes, fits, label, *, strict: bool) -> list[WheelFinding]:
        try:
            from .toolkit.vehicle_review import Wheel, review_wheels
        except ImportError:  # the toolkit needs pyldraw3, which needs Python 3.12
            return []

        wheels = []
        for index, placement in enumerate(placements):
            tyre = self._tyre(placement.part)
            if tyre is None:
                continue
            centre, axis, radius, width = tyre
            matrix = np.array(placement.matrix, dtype=float).reshape(3, 3)
            wheels.append(Wheel(index, tuple(matrix @ centre + np.array(placement.position, dtype=float)),
                                tuple(matrix @ axis), radius, width))
        if not wheels:
            return []
        # A rim and the part that carries it belong to the wheel: they are not in its way.
        mounted = {w.instance for w in wheels}
        for _ in range(2):
            mounted |= {b if a in mounted else a for a, b in fits if (a in mounted) != (b in mounted)}
        # Only the wheels it rolls on turn: a spare on the tailgate or a steering wheel does not.
        rolling = [w for w in wheels if abs(w.axis[1]) < 1e-3]
        if rolling:
            along = max((np.array(w.axis) for w in rolling),
                        key=lambda a: sum(abs(float(a @ np.array(o.axis))) > 0.9999 for o in rolling))
            rolling = [w for w in rolling if abs(float(along @ np.array(w.axis))) > 0.9999]
        findings = self._wheel_space(placements, boxes, rolling, mounted, label)
        if len(wheels) < 2:
            return findings
        others = [(index, min(box[1] for box in own), max(box[4] for box in own))
                  for index, own in boxes.items() if index not in mounted]
        for item in review_wheels(wheels, others, tolerance=COARSE):
            if item["code"] not in MESSAGES:
                continue  # a tyre on another axis (a spare, a steering wheel) is not a fault to report
            instances = tuple(item.get("instances", ()))
            names = [label(i) for i in instances] + ["", ""]
            text = MESSAGES[item["code"]]
            if item["code"] == "vehicle.axle_pair":
                names[0] = "; ".join(label(i) for i in instances)
            findings.append(WheelFinding(item["code"], text.format(*names, **item), instances,
                                         strict and item["code"] in STRICT))
        return findings

    def _wheel_space(self, placements, boxes, wheels, mounted, label) -> list[WheelFinding]:
        """Parts whose real surface is inside the cylinder a tyre sweeps as it turns.

        The toolkit's rule compared the cylinder with each part's outline as a box, which calls a
        wheel arch an obstacle. The tyre's real shape is already round, so the space it turns in is
        the cylinder around it; what is tested against it is the other part's own surface.
        """
        worst: dict[tuple[int, int], float] = {}
        for wheel in wheels:
            centre, axis = np.array(wheel.centre), np.array(wheel.axis)
            reach = wheel.radius + wheel.width
            for index, placement in enumerate(placements):
                if index in mounted:
                    continue
                own = boxes.get(index)
                if own is not None:
                    low = np.array([min(b[k] for b in own) for k in range(3)])
                    high = np.array([max(b[k + 3] for b in own) for k in range(3)])
                    if np.any(low > centre + reach) or np.any(high < centre - reach):
                        continue
                elif np.linalg.norm(np.array(placement.position) - centre) > reach + 80:
                    continue
                depth = self._intrusion(placement, centre, axis, wheel.radius, wheel.width)
                if depth > COARSE:
                    pair = (wheel.instance, index)
                    worst[pair] = max(worst.get(pair, 0.0), depth)
        found = []
        for (tyre, part), depth in sorted(worst.items(), key=lambda item: -item[1])[:4]:
            found.append(WheelFinding("vehicle.wheel_space", MESSAGES["vehicle.wheel_space"].format(
                label(tyre), label(part), intrusion=depth), (tyre, part)))
        return found

    def _intrusion(self, placement: Placement, centre, axis, radius: float, width: float) -> float:
        """How far a part's surface reaches into a tyre's cylinder, in LDU; 0 when it stays out."""
        try:
            triangles = self._library.surface(placement.part)
        except LDrawError:
            return 0.0
        if not len(triangles):
            return 0.0
        matrix = np.array(placement.matrix, dtype=float).reshape(3, 3)
        points = np.concatenate([triangles.reshape(-1, 3), triangles.mean(axis=1)])
        points = points @ matrix.T + np.array(placement.position, dtype=float) - centre
        along = points @ axis
        radial = np.linalg.norm(points - np.outer(along, axis), axis=1)
        # What the tyre stands on reaches up into the bottom of its circle (a road's studs): that is
        # where it meets the ground, not something in its way.
        above_ground = points[:, 1] < radius - GROUND_CONTACT
        inside = (np.abs(along) < width / 2 - COARSE) & (radial < radius) & above_ground
        return float((radius - radial[inside]).max()) if inside.any() else 0.0

    def _symmetry(self, placements, boxes, label, kind: str) -> list[WheelFinding]:
        """Whether a plane or boat is its own mirror image across its length, by the parts' outlines."""
        items = [(index, (min(b[0] for b in own), min(b[1] for b in own), min(b[2] for b in own),
                          max(b[3] for b in own), max(b[4] for b in own), max(b[5] for b in own)))
                 for index, own in boxes.items()]
        ground = max((box[4] for _, box in items), default=0.0)
        items = [(index, box) for index, box in items if box[1] < ground - GROUND_LAYER]
        if len(items) < 4:
            return []
        low = [min(box[k] for _, box in items) for k in range(3)]
        high = [max(box[k + 3] for _, box in items) for k in range(3)]
        # A boat is mirrored across its width, the shorter way; a plane may be longer either way.
        axes = (0, 2) if kind == "aircraft" else ((0,) if high[0] - low[0] < high[2] - low[2] else (2,))
        best = None
        total = sum(_volume(box) for _, box in items) or 1e-9
        for k in axes:
            # The mirror plane goes through the centre of the model's mass, not of its outline: a wing
            # missing on one side moves the outline's middle onto what is left.
            middle = sum(_volume(box) * (box[k] + box[k + 3]) / 2 for _, box in items) / total
            unmatched = self._unmatched(items, k, middle)
            share = sum(volume for _, volume in unmatched) / max(sum(_volume(box) for _, box in items), 1e-9)
            if best is None or share < best[0]:
                best = (share, unmatched)
        share, unmatched = best
        if share <= UNMATCHED:
            return []
        largest = [index for index, _ in sorted(unmatched, key=lambda item: -item[1])[:3]]
        names = "; ".join(label(index) for index in largest)
        return [WheelFinding("vehicle.symmetry", MESSAGES["vehicle.symmetry"].format(
            kind="plane" if kind == "aircraft" else "boat", share=share, parts=names), tuple(largest))]

    @staticmethod
    def _unmatched(items, k: int, middle: float) -> list[tuple[int, float]]:
        """Parts with no part of the same size where their mirror image across ``middle`` would be."""
        cell = MIRROR_PLAY * 2
        grid: dict[tuple[int, ...], list[tuple]] = {}
        for _, box in items:
            key = tuple(int((box[i] + box[i + 3]) / 2 // cell) for i in range(3))
            grid.setdefault(key, []).append(box)
        missing = []
        for index, box in items:
            mirrored = list(box)
            mirrored[k], mirrored[k + 3] = 2 * middle - box[k + 3], 2 * middle - box[k]
            key = [int((mirrored[i] + mirrored[i + 3]) / 2 // cell) for i in range(3)]
            near = [other for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                    for other in grid.get((key[0] + dx, key[1] + dy, key[2] + dz), ())]
            if not any(all(abs(a - b) <= MIRROR_PLAY for a, b in zip(mirrored, other)) for other in near):
                missing.append((index, _volume(box)))
        return missing

    def _tyre(self, part: str) -> tuple | None:
        """A tyre's centre, the axis it turns on, its radius and its width, in its own frame."""
        if part not in self._tyres:
            self._tyres[part] = None
            try:
                if self._library.description(part).lstrip("~_=").startswith("Tyre"):
                    points = self._library.surface(part).reshape(-1, 3)
                    low, high = points.min(axis=0), points.max(axis=0)
                    size = high - low
                    for turning in range(3):  # the axis whose other two sizes agree: a disc seen edge on
                        first, second = (size[k] for k in range(3) if k != turning)
                        if abs(first - second) <= 1.5 and first > 4:
                            self._tyres[part] = ((low + high) / 2, np.eye(3)[turning], float(max(first, second)) / 2,
                                                 float(size[turning]))
                            break
            except LDrawError:
                pass
        return self._tyres[part]


def _volume(box) -> float:
    return max(box[3] - box[0], 0.0) * max(box[4] - box[1], 0.0) * max(box[5] - box[2], 0.0)
