"""Pack a design, measure vertical stud contacts and order the physical parts."""

from __future__ import annotations

import heapq
from collections import Counter
from dataclasses import dataclass
from functools import cache

from .design import read_design
from .parts import BRICKS, PLATES, Piece


def pack(scene, phase=0):
    cells = scene.cells.copy()
    pieces = []
    studs = {}

    def install(piece):
        top = piece.y + piece.shape.height
        for x, z in piece.studs():
            studs[x, top, z] = len(pieces)
        pieces.append(piece)

    for piece in scene.fixed:
        install(piece)

    @cache
    def options(color):
        return [
            (s, turn, w, d)
            for s in (*BRICKS, *PLATES)
            if (s.part, color) in scene.catalog.parts
            for turn, w, d in (
                [(0, s.width, s.depth)]
                if s.width == s.depth
                else [(0, s.width, s.depth), (1, s.depth, s.width)]
            )
        ]

    # Offset alternate courses by a stud so plate seams can bridge even when
    # both courses have the same outline. Only the visit order is offset.
    xmin = min((x for x, _, _ in cells), default=0)
    zmin = min((z for _, _, z in cells), default=0)
    xmax = max((x for x, _, _ in cells), default=0)
    zmax = max((z for _, _, z in cells), default=0)

    def order(cell):
        x, y, z = cell
        shift = (y + phase) % 2
        return (
            y,
            zmax - zmin >= 5 and z < zmin + shift,
            xmax - xmin >= 5 and x < xmin + shift,
            (x, z) if phase else (z, x),
        )

    for x, y, z in sorted(cells, key=order):
        color = cells.get((x, y, z))
        if color is None:
            continue
        best, best_score = None, ()
        for shape, turn, w, d in options(color):
            h = shape.height
            if not all(
                cells.get((x + i, y + j, z + k)) == color
                for j in range(h)
                for k in range(d)
                for i in range(w)
            ):
                continue
            contacts = {
                studs[x + i, y, z + k]
                for k in range(d)
                for i in range(w)
                if (x + i, y, z + k) in studs
            }
            # Prefer a supported placement, then volume. Among comparable
            # footprints, favor crossing the joints in the course below.
            score = (
                bool(contacts),
                w * d * h + min(3, max(0, len(contacts) - 1)) * 2,
                h,
                w * d,
                d if (y + phase) % 2 else w,
            )
            if score > best_score:
                best, best_score = (shape, turn, w, d), score
        if best is None:
            raise ValueError(
                f"No stock rectangle fits color {color} at {(x, y, z)}. "
                "Change its color or use a listed detail part"
            )
        shape, turn, w, d = best
        install(Piece(shape, color, x, y, z, turn))
        for j in range(shape.height):
            for k in range(d):
                for i in range(w):
                    del cells[x + i, y + j, z + k]
        if len(pieces) > 5000:
            raise ValueError("Draft exceeds 5,000 placements. Reduce its scale")
    return pieces


def connected_groups(pieces):
    sockets = {(x, p.y, z): i for i, p in enumerate(pieces) for x, z in p.sockets()}
    links = [set() for _ in pieces]
    for i, p in enumerate(pieces):
        for x, z in p.studs():
            other = sockets.get((x, p.y + p.shape.height, z))
            if other is not None:
                links[i].add(other)
                links[other].add(i)

    # Grow each assembly from its lowest part. Within the reachable frontier
    # choose the next lowest attachment, using placement order to break ties.
    seen, groups = set(), []
    for start in sorted(range(len(pieces)), key=lambda i: (pieces[i].y, i)):
        if start in seen:
            continue
        queue, group = [(pieces[start].y, start)], []
        seen.add(start)
        while queue:
            _, i = heapq.heappop(queue)
            group.append(pieces[i])
            for other in links[i] - seen:
                seen.add(other)
                heapq.heappush(queue, (pieces[other].y, other))
        groups.append(group)
    return sorted(groups, key=len, reverse=True)


@dataclass
class Assembly:
    pieces: list[Piece]
    inventory: Counter
    issues: list[str]

    def ldraw(self, *, steps=True):
        rows = ["0 Astra BrickBuilder model", "0 Name: model.ldr"]
        for i, piece in enumerate(self.pieces):
            if steps and i and i % 5 == 0:
                rows.append("0 STEP")
            rows.append(piece.ldraw())
        return "\n".join(rows) + "\n"


def assemble(program, catalog, limit):
    if type(limit) is not int or not 1 <= limit <= 5000:
        raise ValueError("Piece limit must be 1..5,000")
    scene = read_design(program, catalog)
    groups = connected_groups(pack(scene))
    if len(groups) > 1:
        # Try a second bond pattern before asking the designer to alter the shape.
        other = connected_groups(pack(scene, phase=1))
        if (len(other), sum(map(len, other))) < (len(groups), sum(map(len, groups))):
            groups = other
    pieces = [p for group in groups for p in group]
    inventory = Counter((p.shape.part, p.color) for p in pieces)
    catalog.validate(inventory)
    issues = []
    if len(pieces) > limit:
        issues.append(f"{len(pieces)} pieces exceed the limit of {limit}")
    if len(groups) > 1:
        samples = []
        for group in groups[1:9]:
            p = group[0]
            samples.append(f"{len(group)} pcs near {p.shape.part}/{p.color} at {(p.x, p.y, p.z)}")
        issues.append(
            f"{len(groups)} disconnected stud groups. Parts outside the largest: "
            + ", ".join(samples)
            + ". Bridge their seams with a studded course"
        )
    return Assembly(pieces, inventory, issues)
