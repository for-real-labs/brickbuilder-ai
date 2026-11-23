"""Interpret named, editable sections of a build on a bounded stud grid."""

from __future__ import annotations

import re

from .parts import SHAPES, Piece

SECTION_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _-]{0,47}\Z")
MAX_WORK = 240_000


def check_box(x, y, z, w, h, d):
    if min(w, h, d) < 1 or not (
        -64 <= x < x + w <= 64 and -64 <= z < z + d <= 64 and 0 <= y < y + h <= 96
    ):
        raise ValueError("Use positive dimensions within X/Z -64..63 and Y 0..95")


def sections(value):
    if not isinstance(value, dict) or not 1 <= len(value) <= 48:
        raise ValueError("Expected 1..48 named design sections")
    for name, program in value.items():
        if not isinstance(name, str) or not SECTION_NAME.fullmatch(name):
            raise ValueError("Invalid section name")
        if not isinstance(program, str) or not program.strip() or len(program) > 8192:
            raise ValueError(f"Invalid or oversized section {name}")
    if sum(len(program.splitlines()) for program in value.values()) > 400:
        raise ValueError("Use at most 400 design lines")
    return value


class Scene:
    def __init__(self, catalog):
        self.catalog = catalog
        self.colors = {color for _, color in catalog.parts}
        self.cells = {}
        self.fixed = []
        self.reserved = set()
        self.work = 0

    def charge(self, amount):
        self.work += amount
        if self.work > MAX_WORK:
            raise ValueError("Design exceeds the grid work limit")

    def fill(self, color, x, y, z, w, h, d, *, walls=False):
        check_box(x, y, z, w, h, d)
        if color != -1 and color not in self.colors:
            raise ValueError(f"Unknown catalog color {color}")
        self.charge(w * h * d)
        for i in range(w):
            for k in range(d):
                if walls and i not in (0, w - 1) and k not in (0, d - 1):
                    continue
                for j in range(h):
                    key = x + i, y + j, z + k
                    if color == -1:
                        self.cells.pop(key, None)
                    else:
                        self.cells[key] = color

    def place(self, part, color, x, y, z, turn):
        shape = SHAPES.get(part)
        if shape is None:
            raise ValueError(f"Unknown geometry {part}. Use find_parts for supported parts")
        if (part, color) not in self.catalog.parts:
            raise ValueError(f"{part} is unavailable in color {color}. Use find_parts")
        if turn not in range(4):
            raise ValueError("Use a quarter turn in 0..3")
        piece = Piece(shape, color, x, y, z, turn)
        w, d = piece.size
        check_box(x, y, z, w, shape.height, d)
        self.charge(w * d * shape.height)
        volumes = {(a, b, c) for a, c in piece.sockets() for b in range(y, y + shape.height)}
        if self.reserved & volumes:
            raise ValueError(f"Overlapping detail pieces at {min(self.reserved & volumes)}")
        self.reserved.update(volumes)
        self.fixed.append(piece)

    def profile(self, color, x, y, z, face, thickness, drawing):
        rows = drawing.split("/")
        width = len(rows[0])
        if (
            not 1 <= len(rows) <= 64
            or not 1 <= width <= 64
            or thickness < 1
            or any(len(row) != width or set(row) - {".", "#"} for row in rows)
        ):
            raise ValueError("A profile needs equal rows of 1..64 dots and hashes")
        if face not in ("front", "side", "top"):
            raise ValueError("Choose front, side or top for a profile")
        for j, row in enumerate(rows):
            for i, mark in enumerate(row):
                if mark == ".":
                    continue
                if face == "top":
                    self.fill(color, x + i, y, z + j, 1, thickness, 1)
                elif face == "front":
                    self.fill(color, x + i, y + len(rows) - 1 - j, z, 1, 1, thickness)
                else:
                    self.fill(color, x, y + len(rows) - 1 - j, z + i, thickness, 1, 1)

    def roof(self, color, x, y, z, width, depth, ridge, pitch, gable):
        if ridge not in ("x", "z") or pitch not in ("steep", "shallow", "gambrel"):
            raise ValueError("A roof needs ridge x/z and pitch steep/shallow/gambrel")
        span, length = (depth, width) if ridge == "x" else (width, depth)
        if not 4 <= span <= 32 or not 1 <= length <= 48:
            raise ValueError("A roof spans 4..32 studs and runs 1..48 along the ridge")

        def strip(col, across, along, bottom, wide, long, high):
            if ridge == "x":
                self.fill(col, x + along, bottom, z + across, long, high, wide)
            else:
                self.fill(col, x + across, bottom, z + along, wide, high, long)

        strip(gable, 0, 0, y, span, length, 1)
        cross, bottom = 0, y + 1
        while span - 2 * cross > 3:
            shallow = pitch == "shallow" or pitch == "gambrel" and cross >= max(1, span // 5)
            run = 2 if shallow and span - 2 * cross >= 6 else 1
            pair, single = ("3298", "4286") if run == 2 else ("3039", "3040b")
            along = 0
            while along < length:
                # Stagger the along-ridge seam so adjacent slope strips bond.
                leading_single = (
                    along == 0
                    and (bottom - y - 1) // 3 % 2
                    and (single, color) in self.catalog.parts
                )
                double = (
                    not leading_single
                    and along + 2 <= length
                    and (pair, color) in self.catalog.parts
                )
                part = pair if double else single
                for low, turn in ((cross, 0), (span - cross - run - 1, 2)):
                    if ridge == "x":
                        self.place(part, color, x + along, bottom, z + low, turn)
                    else:
                        self.place(part, color, x + low, bottom, z + along, (turn + 1) % 4)
                along += 2 if double else 1
            cross += run
            inside = span - 2 * cross - 2
            if inside > 0:
                for end in {0, length - 1}:
                    strip(gable, cross + 1, end, bottom, inside, 1, 3)
            bottom += 3
        strip(color, cross, 0, bottom, span - 2 * cross, length, 1)

    def line(self, words, offset=(0, 0, 0), *, repeated=False):
        kind, *args = words
        if kind == "repeat":
            if repeated or len(args) < 5:
                raise ValueError("repeat needs count dx dy dz and a single command")
            count, dx, dy, dz = map(int, args[:4])
            if not 1 <= count <= 64:
                raise ValueError("Repeat count must be 1..64")
            for i in range(count):
                self.line(args[4:], (i * dx, i * dy, i * dz), repeated=True)
            return
        part = args.pop(0) if kind == "part" and args else ""
        if len(args) < 4:
            raise ValueError(f"Incomplete {kind} command")
        color, x, y, z = map(int, args[:4])
        x, y, z = x + offset[0], y + offset[1], z + offset[2]
        tail = args[4:]
        if kind in ("box", "shell") and len(tail) == 3:
            self.fill(color, x, y, z, *map(int, tail), walls=kind == "shell")
        elif kind == "part" and len(tail) == 1:
            self.place(part, color, x, y, z, int(tail[0]))
        elif kind == "profile" and len(tail) == 3:
            self.profile(color, x, y, z, tail[0], int(tail[1]), tail[2])
        elif kind == "roof" and len(tail) == 5:
            self.roof(color, x, y, z, int(tail[0]), int(tail[1]), tail[2], tail[3], int(tail[4]))
        else:
            raise ValueError(f"Unknown command or wrong argument count for {kind}")


def read_design(program, catalog):
    scene = Scene(catalog)
    for name, body in sections(program).items():
        for number, line in enumerate(body.splitlines(), 1):
            if not line.strip():
                continue
            try:
                scene.line(line.split())
            except ValueError as error:
                raise ValueError(f"{name}, line {number}: {error}") from None
    for key in scene.reserved:
        scene.cells.pop(key, None)
    return scene
