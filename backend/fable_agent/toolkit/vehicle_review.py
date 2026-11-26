# Part of BrickBuilder's copy of the "ldraw-nova" agent toolkit.
# Copyright (c) 2026 Carlos Antelo and contributors (https://github.com/anteloc/ldraw-nova),
# with changes by Jake Johnson in his fork at commit d98e9fe6b82ea725322db0dbc74519159f204f5e.
# Licensed under the GNU Affero General Public License, version 3: see LICENSE-AGPL-3.0 at the
# root of this repository and NOTICE.md in this folder. There is NO WARRANTY.
# Modified by BrickBuilder, 2026-11-26: the road profile of review_vehicle, rewritten to work in any
# frame. The original expects a vehicle centred on X=0 that drives along Z on the plane Y=0; here
# the axle direction, the centre line and the road plane are measured from the tyres, so a build
# may face any way and stand at any height. Input is plain measurements instead of a pyldraw3
# model. The rim-fit test is left to the connector data, a base that lies wholly under the road
# plane is not reported as below it, the tolerance is an argument, the wheel-space test keeps the original rule (upright
# rectangular bodies only), and the motorcycle, watercraft and aircraft profiles,
# which look for the named parts of the toolkit's own example plans, are not copied.
"""Bounded review of wheels as running gear: road contact, axle pairs, symmetry and rolling room."""
from __future__ import annotations

import json
from dataclasses import dataclass

import numpy as np

from .common import DATA, issue

TOLERANCE = .05  # Rounding/tessellation allowance in LDU, not mechanical clearance.
UP = np.array([0.0, -1.0, 0.0])  # LDraw's Y points down


@dataclass(frozen=True)
class Wheel:
    """One tyre as placed: where its centre is, the line it turns on, and its size in LDU."""

    instance: int
    centre: tuple[float, float, float]
    axis: tuple[float, float, float]
    radius: float
    width: float


def profiles():
    return json.loads((DATA / "rectangular-parts.json").read_text())["parts"]


def body_box(position, matrix, profile):
    """Envelope of an upright, unscaled, quarter-turn rectangular brick/plate body."""
    matrix = np.asarray(matrix, dtype=float).reshape(3, 3)
    if not np.allclose(matrix[:, 1], [0, 1, 0], atol=1e-6) or not np.allclose(matrix, np.round(matrix), atol=1e-6):
        return None
    if not np.allclose(matrix.T @ matrix, np.eye(3), atol=1e-6) or np.linalg.det(matrix) < 0:
        return None
    x, z, h = profile["x_studs"] * 10, profile["z_studs"] * 10, profile["height"]
    corners = np.array([[sx * x, sy * h, sz * z] for sx in (-1, 1) for sy in (0, 1) for sz in (-1, 1)])
    corners = corners @ matrix.T + np.asarray(position, dtype=float)
    return np.array([corners.min(axis=0), corners.max(axis=0)])


def review_wheels(wheels, others=(), bodies=(), tolerance=TOLERANCE):
    """Diagnostics for the tyres of one build.

    ``others`` are ``(instance, top_y, bottom_y)`` of everything that is not part of a wheel
    (Y points down, so ``bottom_y`` is the larger). ``bodies`` are ``(instance, box)`` envelopes
    from ``body_box`` of parts that are not part of a wheel. ``tolerance`` is how far, in LDU, a
    measurement may be off before it is reported.
    """
    diagnostics = []
    rolling = [w for w in wheels if abs(float(np.dot(w.axis, UP))) < 1e-3]
    if len(rolling) < 2:
        return diagnostics
    # The commonest axle direction is the vehicle's; a spare or a steered wheel is left aside.
    across = max((np.asarray(w.axis, dtype=float) for w in rolling),
                 key=lambda a: sum(abs(float(np.dot(a, o.axis))) > .9999 for o in rolling))
    road = [w for w in rolling if abs(float(np.dot(across, w.axis))) > .9999]
    if len(road) < len(rolling):
        diagnostics.append(issue('vehicle.unreviewed_wheels', 'Additional wheels/tyres turn on another axis and need manual fit and ground review.',
                                 severity='warning', count=len(rolling) - len(road)))
    if len(road) < 2:
        return diagnostics
    along = np.cross(across, UP)
    ground_y = max(w.centre[1] + w.radius for w in road)
    for w in road:
        error = w.centre[1] + w.radius - ground_y
        if abs(error) > tolerance:
            diagnostics.append(issue('vehicle.ground_contact', 'Tyre does not meet the road plane the other tyres stand on.',
                                     severity='warning', instances=[w.instance], ground_error_ldu=float(error)))
    # What lies wholly under the road plane is a base the tyres stand on; what crosses it is
    # bodywork that reaches lower than the tyres.
    crossing = [(bottom, instance) for instance, top, bottom in others
                if top < ground_y - tolerance and bottom > ground_y + tolerance]
    if crossing:
        bottom, instance = max(crossing)
        diagnostics.append(issue('vehicle.below_road', 'Non-tyre geometry extends below the road plane.',
                                 severity='warning', instances=[instance], count=len(crossing),
                                 below_ldu=float(bottom - ground_y)))
    centre_line = float(np.mean([np.dot(w.centre, across) for w in road]))
    axles = []
    for w in sorted(road, key=lambda w: float(np.dot(w.centre, along))):
        station = float(np.dot(w.centre, along))
        group = next((a for a in axles if abs(a['station'] - station) <= tolerance), None)
        if group is None:
            group = dict(station=station, wheels=[])
            axles.append(group)
        group['wheels'].append(w)
    single_track = all(len(a['wheels']) == 1 for a in axles)  # a motorcycle or bicycle: one wheel per station
    for a in axles:
        pair = sorted(a['wheels'], key=lambda w: float(np.dot(w.centre, across)))
        instances = [w.instance for w in pair]
        if single_track:
            if abs(float(np.dot(pair[0].centre, across)) - centre_line) > tolerance:
                diagnostics.append(issue('vehicle.motorcycle_wheel', 'Expected one centreline wheel at each station of a two-wheeler.',
                                         severity='warning', instances=instances))
            continue
        if len(pair) % 2:
            diagnostics.append(issue('vehicle.axle_pair', 'Expected a left/right wheel pair at this axle station.',
                                     severity='warning', instances=instances))
            continue
        for left, right in zip(pair[:len(pair) // 2], reversed(pair[len(pair) // 2:])):
            a_side, b_side = (float(np.dot(w.centre, across)) - centre_line for w in (left, right))
            if (a_side >= 0 or b_side <= 0 or abs(a_side + b_side) > tolerance
                    or abs(left.centre[1] - right.centre[1]) > tolerance or abs(left.radius - right.radius) > tolerance):
                diagnostics.append(issue('vehicle.axle_symmetry', 'Wheel pair is not symmetric about the centre line at equal height/radius.',
                                         severity='warning', instances=[left.instance, right.instance]))
    # Conservative full circular swept space, with an axial slab. This
    # reserves rolling room, not the rubber's actual hollow material volume.
    intrusions = []
    for w in road:
        centre = np.asarray(w.centre, dtype=float)
        side, height, travel = float(np.dot(centre, across)), centre[1], float(np.dot(centre, along))
        for instance, box in bodies:
            corners = np.array([[box[i, 0], box[j, 1], box[k, 2]] for i in (0, 1) for j in (0, 1) for k in (0, 1)])
            sides, travels = corners @ across, corners @ along
            if min(sides.max(), side + w.width / 2) - max(sides.min(), side - w.width / 2) <= tolerance:
                continue
            nearest = np.array([min(max(height, box[0, 1]), box[1, 1]), min(max(travel, travels.min()), travels.max())])
            distance = float(np.linalg.norm(nearest - np.array([height, travel])))
            if distance < w.radius - tolerance:
                intrusions.append((w.instance, instance, w.radius - distance))
    if intrusions:
        worst = max(intrusions, key=lambda item: item[2])
        diagnostics.append(issue('vehicle.wheel_space', 'Rectangular body envelopes enter circular wheel space; review rolling clearance.',
                                 severity='warning', count=len(intrusions), instances=[worst[0], worst[1]],
                                 radial_intrusion_ldu=float(worst[2])))
    return diagnostics
