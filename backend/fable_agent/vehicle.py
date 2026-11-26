"""Wheels reviewed as running gear: do the tyres stand on one road, in pairs, with room to turn.

The rules are the toolkit's vehicle review (``toolkit/vehicle_review``). This module measures a
build for it: where each tyre is and how large, and what reaches lower than the tyres. Findings are warnings. A build is not told
to be a vehicle, so a cart with one axle or a car on a display base is not an error.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .kit import Placement
from .ldraw import LDrawError, LDrawLibrary

COARSE = 2.0  # LDU: a quarter of a plate, the accuracy of the coarse shapes the measurements come from
MESSAGES = {
    "vehicle.ground_contact": "{0} is a tyre that does not stand on the ground the other tyres stand on "
                              "(off by {ground_error_ldu:.0f} LDU). Put every axle at a height that suits its tyre.",
    "vehicle.below_road": "{0} reaches {below_ldu:.0f} LDU below the tyres ({count} such part(s)), so the model "
                          "would rest on it and not on its wheels. Raise it or lower the axles.",
    "vehicle.axle_pair": "The wheels at one axle are not a left and right pair: {0}.",
    "vehicle.axle_symmetry": "{0} and {1} are one axle but are not mirror images: different height, size or "
                             "distance from the middle of the vehicle.",
    "vehicle.motorcycle_wheel": "{0} is off the centre line the other wheel of this two-wheeler is on.",
}


@dataclass(frozen=True)
class WheelFinding:
    code: str
    message: str
    placements: tuple[int, ...]


class WheelReview:
    def __init__(self, library: LDrawLibrary):
        self._library = library
        self._tyres: dict[str, tuple | None] = {}

    def review(self, placements: list[Placement], boxes: dict[int, list], fits: set[tuple[int, int]],
               label: Callable[[int], str]) -> list[WheelFinding]:
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
        if len(wheels) < 2:
            return []
        # A rim and the part that carries it belong to the wheel: they are not in its way.
        mounted = {w.instance for w in wheels}
        for _ in range(2):
            mounted |= {b if a in mounted else a for a, b in fits if (a in mounted) != (b in mounted)}
        others = [(index, min(box[1] for box in own), max(box[4] for box in own))
                  for index, own in boxes.items() if index not in mounted]
        findings = []
        # The wheel-space rule of the toolkit is not applied: it treats a tyre as a full cylinder, and the
        # solid-plastic check already measures the tyre's real surface against what is near it.
        for item in review_wheels(wheels, others, tolerance=COARSE):
            if item["code"] not in MESSAGES:
                continue  # a tyre on another axis (a spare, a steering wheel) is not a fault to report
            instances = tuple(item.get("instances", ()))
            names = [label(i) for i in instances] + ["", ""]
            text = MESSAGES[item["code"]]
            if item["code"] == "vehicle.axle_pair":
                names[0] = "; ".join(label(i) for i in instances)
            findings.append(WheelFinding(item["code"], text.format(*names, **item), instances))
        return findings

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
