"""Upright LDraw geometry in stud columns and plate courses."""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product


@dataclass(frozen=True)
class Shape:
    part: str
    width: int
    depth: int
    height: int
    top: str = "studs"


# Native LDraw templates run along X. Slopes rise toward +Z and their
# origin is on the high row. Width and depth describe the bottom footprint.
def rectangles(height, rows, top="studs"):
    return tuple(Shape(part, w, d, height, top) for part, w, d in rows)


PLATES = rectangles(
    1,
    [
        ("3033", 10, 6),
        ("3030", 10, 4),
        ("3036", 8, 6),
        ("3958", 6, 6),
        ("3035", 8, 4),
        ("3032", 6, 4),
        ("3031", 4, 4),
        ("3832", 10, 2),
        ("3034", 8, 2),
        ("3795", 6, 2),
        ("3020", 4, 2),
        ("3021", 3, 2),
        ("3022", 2, 2),
        ("3460", 8, 1),
        ("3666", 6, 1),
        ("3710", 4, 1),
        ("3623", 3, 1),
        ("3023", 2, 1),
        ("3024", 1, 1),
    ],
)
BRICKS = rectangles(
    3,
    [
        ("3007", 8, 2),
        ("2456", 6, 2),
        ("3001", 4, 2),
        ("3002", 3, 2),
        ("3003", 2, 2),
        ("3008", 8, 1),
        ("3009", 6, 1),
        ("3010", 4, 1),
        ("3622", 3, 1),
        ("3004", 2, 1),
        ("3005", 1, 1),
    ],
)
DETAILS = (
    *rectangles(
        1,
        [
            ("4162", 8, 1),
            ("6636", 6, 1),
            ("2431", 4, 1),
            ("63864", 3, 1),
            ("3069b", 2, 1),
            ("3070b", 1, 1),
            ("3068b", 2, 2),
            ("87079", 4, 2),
            ("2412b", 2, 1),
        ],
        "smooth",
    ),
    Shape("3633", 4, 1, 3, "smooth"),
    Shape("60592", 2, 1, 6),
    Shape("60594", 4, 1, 9),
    Shape("98283", 2, 1, 3),
    Shape("3062b", 1, 1, 3),
    Shape("4073", 1, 1, 1),
    Shape("3039", 2, 2, 3, "slope"),
    Shape("3040b", 1, 2, 3, "slope"),
    Shape("3298", 2, 3, 3, "slope"),
    Shape("4286", 1, 3, 3, "slope"),
)
SHAPES = {s.part: s for s in (*PLATES, *BRICKS, *DETAILS)}
MATRICES = ("1 0 0 0 1 0 0 0 1", "0 0 1 0 1 0 -1 0 0", "-1 0 0 0 1 0 0 0 -1", "0 0 -1 0 1 0 1 0 0")


@dataclass(frozen=True)
class Piece:
    shape: Shape
    color: int
    x: int
    y: int
    z: int
    turn: int = 0

    @property
    def size(self):
        s = self.shape
        return (s.depth, s.width) if self.turn % 2 else (s.width, s.depth)

    def column(self, u, v):
        w, d = self.shape.width - 1, self.shape.depth - 1
        a, b = ((u, v), (v, w - u), (w - u, d - v), (d - v, u))[self.turn]
        return self.x + a, self.z + b

    def sockets(self):
        w, d = self.size
        return product(range(self.x, self.x + w), range(self.z, self.z + d))

    def studs(self):
        if self.shape.top == "smooth":
            return ()
        if self.shape.top == "slope":
            return (self.column(u, self.shape.depth - 1) for u in range(self.shape.width))
        return self.sockets()

    def ldraw(self):
        s = self.shape
        u = (s.width - 1) / 2
        v = s.depth - 1 if s.top == "slope" else (s.depth - 1) / 2
        x, z = self.column(u, v)
        return (
            f"1 {self.color} {20 * x:g} {-8 * (self.y + s.height)} {20 * z:g} "
            f"{MATRICES[self.turn]} {s.part}.dat"
        )
