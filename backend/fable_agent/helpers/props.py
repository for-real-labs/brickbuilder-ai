"""Ready-made small things that stand on their own: plants, lamps, chimneys and columns.

Each is a stack: one part set on the studs of the one below, centered over a small square base.
The recipes only put a part where the part under it has a stud for it (a single round brick on a
center stud, a 2 x 2 part on four studs), so a stack holds together. A part that is not stocked in
the color asked for is placed in the closest color it does come in.
"""

from __future__ import annotations

from dataclasses import dataclass

from math import cos, radians, sin

from ..kit import Kit, KitError
from .common import BRICK, Helper, brick_color, choice, first_stocked, stocked, whole

# A layer is (part or parts to try, color role[, dx, dz]). A role names one of the helper's color
# arguments, or is a fixed color. ``dx, dz`` place the layer off-center, in studs from the base's corner.
Layer = tuple


@dataclass(frozen=True)
class Stack:
    base: int  # studs across the square it stands on
    below: tuple[Layer, ...] = ()
    shaft: tuple[Layer, ...] = ()  # repeated to make up the height
    above: tuple[Layer, ...] = ()
    colors: tuple[tuple[str, str], ...] = ()  # default color of each role


STEM, BLOOM = "3741a", "3742"  # a stem with three stalks, and the flower that goes on each


def _on_stalk(turn: float) -> tuple[float, ...]:
    """A flower leaning out 15 degrees on a stalk that points ``turn`` degrees round the stem."""
    c, s, lean_c, lean_s = cos(radians(turn)), sin(radians(turn)), cos(radians(15)), sin(radians(15))
    return (c, -s * lean_s, s * lean_c, 0.0, lean_c, lean_s, -s, -c * lean_s, c * lean_c)


# Where official sets seat the three flowers of a stem (docs/fable-helpers.md).
BLOOMS = (((0, -17.6, 15), _on_stalk(0)), ((15.2, -27.3, -8.8), _on_stalk(120)), ((-14.1, -22.5, -8.1), _on_stalk(240)))


def _resolve(role: str, colors: dict[str, str]) -> str:
    return colors.get(role, role)


def _build(kit: Kit, x, y, z, look: Stack, colors: dict[str, str], repeats: int, helper: str) -> list[int]:
    placed, level = [], y
    plan = list(look.below) + list(look.shaft) * repeats + list(look.above)
    for layer in plan:
        parts, role = layer[0], layer[1]
        color = _resolve(role, colors)
        if isinstance(parts, tuple) and parts and parts[0] == "fill":
            _, kind, size = parts
            corner = (look.base - size) / 2
            cells = {(int(x + corner) + i, int(z + corner) + j) for i in range(size) for j in range(size)}
            placed += kit.fill(cells, level, brick_color(kit, color, helper, kind), kind=kind)
            level += BRICK if kind == "brick" else 1
            continue
        found = first_stocked(kit, (parts,) if isinstance(parts, str) else parts, color)
        if found is None:
            continue  # this library has no such part: the stack goes on without it
        part, code = found
        _, wide, deep, tall = kit.measure(part)
        if len(layer) == 4:
            placed.append(kit.place(part, code, x + layer[2], level, z + layer[3]))
            continue  # an extra beside the stack does not raise it
        if part == STEM:  # its stud is off the middle of its box: seat the stud on the grid, then the flowers
            stud = kit.part(part).studs[0]
            host = kit.place(part, code, x + look.base / 2 - stud[0], level, z + look.base / 2 - stud[1])
            placed.append(host)
            bloom = stocked(kit, BLOOM, _resolve("color", colors))
            if bloom is not None:
                placed += [kit.attach(BLOOM, bloom, host, offset, turn, "flower on its stalk")
                           for offset, turn in BLOOMS]
            level += tall
            continue
        placed.append(kit.place(part, code, x + (look.base - wide) / 2, level, z + (look.base - deep) / 2))
        level += tall
    return placed


def _helper(name: str, styles: dict[str, Stack], signature: str, summary: str, roles: tuple[str, ...],
            sized: bool):
    def build(kit: Kit, x, y, z, *args, **kwargs) -> list[int]:
        names = (("height",) if sized else ()) + ("style",) + roles
        given = dict(zip(names, args))
        if len(args) > len(names) or any(key not in names or key in given for key in kwargs):
            raise KitError(f"{name}() does not take those arguments. Call it as {signature}")
        given.update(kwargs)
        style = choice(given.get("style", next(iter(styles))), styles, "style", name)
        look = styles[style]
        whole(x, "x", name), whole(z, "z", name)
        if isinstance(y, bool) or not isinstance(y, (int, float)):
            raise KitError(f"{name}() needs a number of plates for y")
        colors = dict(look.colors)
        for role in roles:
            if given.get(role) is not None:
                kit.color(given[role])
                colors[role] = given[role]
        repeats = 1
        if sized and look.shaft:
            height = whole(given.get("height", 9), "height", name, 1, 150)
            unit = sum(_tall(kit, layer) for layer in look.shaft) or 1
            repeats = max(1, round(height / unit))
        return _build(kit, x, y, z, look, colors, repeats, name)

    notes = {style: f"{look.base}x{look.base}" for style, look in styles.items()}
    return Helper(name=name, build=build, signature=signature, summary=summary, styles=tuple(styles), notes=notes)


def _tall(kit: Kit, layer: Layer) -> float:
    parts = layer[0]
    if isinstance(parts, tuple) and parts and parts[0] == "fill":
        return BRICK if parts[1] == "brick" else 1
    for part in (parts,) if isinstance(parts, str) else parts:
        if kit.has_part(part):
            return kit.measure(part)[3]
    return 0


R1, RP1, R2, RP2, B2, P2 = "3062b", "4073", "3941", "4032a", "3003", "3022"  # round and square bricks and plates
CONE1, CONE2, DOME, DISH, HUB, TILE1 = "59900", "3942c", "30367c", "4740", "18674", "98138"

PLANTS: dict[str, Stack] = {
    "flower": Stack(1, above=((RP1, "stem"), ("24866", "color"))),
    "tulip": Stack(1, above=((R1, "stem"), ("24866", "color")), colors=(("color", "Red"),)),
    "daisy": Stack(1, above=((RP1, "stem"), ("33291", "color"), (TILE1, "Yellow")), colors=(("color", "White"),)),
    "rose": Stack(1, above=((R1, "stem"), ("4728", "color")), colors=(("color", "Red"),)),
    "sunflower": Stack(1, above=((R1, "stem"), (R1, "stem"), (R1, "stem"), ("4728", "color")),
                       colors=(("color", "Yellow"),)),
    "bloom": Stack(1, above=(("4727", "stem"), ("4728", "color")), colors=(("color", "Bright_Pink"),)),
    "sprout": Stack(1, above=(("32607", "stem"),)),
    "seedling": Stack(1, above=((R1, "stem"), ("32607", "stem"))),
    "bamboo": Stack(1, above=((R1, "stem"), (R1, "stem"), (R1, "stem"), ("32607", "stem")),
                    colors=(("stem", "Bright_Green"),)),
    "cactus": Stack(1, above=((R1, "stem"), (R1, "stem"), (R1, "stem"), (RP1, "color")),
                    colors=(("color", "Bright_Pink"),)),
    "cattail": Stack(1, above=((R1, "stem"), (R1, "stem"), (CONE1, "Reddish_Brown"))),
    "wheat": Stack(1, above=((R1, "Tan"), (R1, "Tan"), (CONE1, "Yellow"))),
    "mushroom": Stack(1, above=((R1, "White"), (DISH, "color")), colors=(("color", "Red"),)),
    "shrub": Stack(2, above=((R2, "stem"), (DOME, "stem"))),
    "berry_bush": Stack(2, above=((R2, "stem"), (DOME, "stem"), (RP1, "color")), colors=(("color", "Red"),)),
    "pumpkin": Stack(2, above=((DOME, "Orange"), (RP1, "stem"))),
    "potted": Stack(2, above=((R2, "Dark_Orange"), (RP2, "stem"), (DOME, "stem"))),
    "lily_pad": Stack(2, above=((RP2, "stem"), ("24866", "color", 0, 0)), colors=(("color", "Bright_Pink"),)),
    "stump": Stack(2, above=((R2, "Reddish_Brown"), (RP2, "Tan"))),
    "boxwood": Stack(2, above=((B2, "stem"), (B2, "stem"), (P2, "stem"))),
    "flower_stem": Stack(1, above=((STEM, "stem"),), colors=(("color", "Red"),)),
    "tall_flowers": Stack(1, above=((R1, "stem"), (STEM, "stem")), colors=(("color", "White"),)),
}
for _look in list(PLANTS):
    PLANTS[_look] = Stack(PLANTS[_look].base, PLANTS[_look].below, PLANTS[_look].shaft, PLANTS[_look].above,
                          (("stem", "Green"), ("color", "Yellow")) + PLANTS[_look].colors)

LAMPS: dict[str, Stack] = {
    "street": Stack(2, above=(("11062", "color"), (R1, "light"), (RP1, "color"))),
    "post": Stack(1, above=(("43888", "color"), (R1, "light"), (CONE1, "color"))),
    "short": Stack(1, above=((R1, "color"), (R1, "color"), (R1, "light"), (CONE1, "color"))),
    "bollard": Stack(1, above=((R1, "color"), (RP1, "light"), (TILE1, "color"))),
    "garden": Stack(1, above=((R1, "color"), (R1, "light"), ("54200", "color")), colors=(("color", "Dark_Bluish_Grey"),)),
    "lantern": Stack(1, above=(("3024", "color"), ("3005", "light"), ("3024", "color"), (CONE1, "color"))),
    "torch": Stack(1, above=((R1, "Reddish_Brown"), (R1, "Reddish_Brown"), (CONE1, "light")),
                   colors=(("light", "Trans_Orange"),)),
    "tiki": Stack(1, above=((R1, "Dark_Brown"),) * 4 + ((CONE1, "light"),), colors=(("light", "Trans_Red"),)),
    "candle": Stack(1, above=((R1, "White"), (RP1, "light")), colors=(("light", "Trans_Orange"),)),
    "traffic_light": Stack(1, above=((R1, "color"),) * 3 + ((RP1, "Trans_Green"), (RP1, "Trans_Yellow"),
                                                            (RP1, "Trans_Red"), (TILE1, "color"))),
    "uplight": Stack(1, above=((R1, "color"), (DISH, "light")), colors=(("color", "Dark_Bluish_Grey"),)),
    "tube": Stack(1, above=((RP1, "color"), (R1, "light"), (R1, "light"), (R1, "light"), (TILE1, "color")),
                  colors=(("light", "Trans_Light_Blue"),)),
    "floor": Stack(1, above=((RP1, "color"), ("43888", "color"), (CONE1, "light")), colors=(("light", "Tan"),)),
    "beacon": Stack(2, above=((R2, "color"), (R2, "light"), (DOME, "light")), colors=(("light", "Trans_Red"),)),
    "lighthouse": Stack(2, above=((R2, "White"), (R2, "Red"), (R2, "White"), (R2, "Red"), (R2, "light"),
                                  (DOME, "color"))),
    "campfire": Stack(2, above=((RP2, "Dark_Bluish_Grey"), (CONE1, "Trans_Orange", 0, 0), (CONE1, "light", 1, 1),
                                (RP1, "Trans_Red", 0, 1))),
}
for _look in list(LAMPS):
    LAMPS[_look] = Stack(LAMPS[_look].base, LAMPS[_look].below, LAMPS[_look].shaft, LAMPS[_look].above,
                         (("color", "Black"), ("light", "Trans_Yellow")) + LAMPS[_look].colors)

CHIMNEYS: dict[str, Stack] = {
    "brick": Stack(2, shaft=((B2, "color"),), above=((P2, "trim"),)),
    "stone": Stack(2, shaft=((B2, "color"),), above=((P2, "trim"),),
                   colors=(("color", "Light_Bluish_Grey"), ("trim", "Dark_Bluish_Grey"))),
    "round": Stack(2, shaft=((R2, "color"),), above=((RP2, "trim"),)),
    "capped": Stack(2, shaft=((B2, "color"),), above=((P2, "trim"), ("3068b", "trim"))),
    "pot": Stack(2, shaft=((B2, "color"),), above=((HUB, "trim"), (R1, "Dark_Orange"))),
    "twin_pots": Stack(2, shaft=((B2, "color"),), above=((P2, "trim"), (R1, "Dark_Orange", 0, 0),
                                                         (R1, "Dark_Orange", 1, 1))),
    "crowned": Stack(2, shaft=((B2, "color"),), above=(("3031", "trim"), (B2, "color"))),
    "smoking": Stack(2, shaft=((B2, "color"),), above=((HUB, "trim"), (R1, "White"), (R1, "White"), (RP1, "White"))),
    "stack": Stack(2, shaft=((R2, "color"), (R2, "color"), (R2, "trim")), above=((RP2, "color"),),
                   colors=(("color", "Light_Bluish_Grey"), ("trim", "Red"))),
    "striped": Stack(2, shaft=((R2, "color"), (R2, "trim")), colors=(("color", "Red"), ("trim", "White"))),
    "conical": Stack(2, shaft=((R2, "color"),), above=((CONE2, "trim"),)),
    "slim": Stack(1, shaft=(("3005", "color"),), above=(("3024", "trim"),)),
    "stovepipe": Stack(1, shaft=((R1, "color"),), above=((RP1, "trim"),),
                       colors=(("color", "Black"), ("trim", "Black"))),
    "rain_cap": Stack(1, shaft=((R1, "color"),), above=((DISH, "trim"),),
                      colors=(("color", "Light_Bluish_Grey"), ("trim", "Dark_Bluish_Grey"))),
    "kiln": Stack(4, shaft=(("87081", "color"),), above=(("3943b", "trim"),)),
    "modern": Stack(2, shaft=((B2, "color"),), above=(("3068b", "trim"),),
                    colors=(("color", "Dark_Bluish_Grey"), ("trim", "Black"))),
}
for _look in list(CHIMNEYS):
    CHIMNEYS[_look] = Stack(CHIMNEYS[_look].base, CHIMNEYS[_look].below, CHIMNEYS[_look].shaft, CHIMNEYS[_look].above,
                            (("color", "Dark_Red"), ("trim", "Dark_Bluish_Grey")) + CHIMNEYS[_look].colors)

COLUMNS: dict[str, Stack] = {
    "round": Stack(1, shaft=((R1, "color"),)),
    "square": Stack(1, shaft=(("3005", "color"),)),
    "pillar": Stack(1, shaft=(("43888", "color"),)),
    "capped": Stack(1, shaft=((R1, "color"),), above=((RP1, "trim"), (TILE1, "trim"))),
    "thick": Stack(2, shaft=((R2, "color"),)),
    "square_thick": Stack(2, shaft=((B2, "color"),)),
    "doric": Stack(2, below=((P2, "trim"),), shaft=((R2, "color"),), above=((P2, "trim"),)),
    "banded": Stack(2, shaft=((R2, "color"), (R2, "trim"))),
    "totem": Stack(2, shaft=((R2, "color"), (R2, "trim"), (R2, "Yellow")), above=((DOME, "color"),),
                   colors=(("color", "Red"), ("trim", "Blue"))),
    "spire": Stack(2, shaft=((R2, "color"),), above=((CONE2, "trim"),)),
    "obelisk": Stack(2, shaft=((B2, "color"),), above=(("3688", "color"),)),
    "slender": Stack(2, below=((P2, "trim"), (HUB, "trim")), shaft=((R1, "color"),), above=((RP1, "trim"),)),
    "stand": Stack(2, shaft=(("3940b", "color"),)),
    "girder": Stack(2, shaft=(("95347", "color"),), colors=(("color", "Light_Bluish_Grey"),)),
    "tapered": Stack(4, below=(("3943b", "trim"),), shaft=((R2, "color"),), above=((RP2, "trim"),)),
    "pedestal": Stack(4, below=(("87081", "trim"),), shaft=((R2, "color"),), above=((RP2, "trim"),)),
    "glass": Stack(1, shaft=((R1, "color"),), colors=(("color", "Trans_Clear"),)),
}
for _look in list(COLUMNS):
    COLUMNS[_look] = Stack(COLUMNS[_look].base, COLUMNS[_look].below, COLUMNS[_look].shaft, COLUMNS[_look].above,
                           (("color", "White"), ("trim", "Tan")) + COLUMNS[_look].colors)

_BASE = ("(x, z) is the min corner of the square it stands on and y its base, on studs; the note after each style "
         "is that square in studs.")
PLANT = _helper(
    "plant", PLANTS, 'plant(x, y, z, style="flower", color=None, stem=None)',
    f"A small plant: a flower, a shrub, a cactus. {_BASE} `color` is the bloom or fruit, `stem` the green.",
    ("color", "stem"), sized=False)
LAMP = _helper(
    "lamp", LAMPS, 'lamp(x, y, z, style="street", color=None, light=None)',
    f"A light: a street lamp, a lantern, a torch, a traffic light. {_BASE} `color` is the post, `light` the "
    "glowing part.", ("color", "light"), sized=False)
CHIMNEY = _helper(
    "chimney", CHIMNEYS, 'chimney(x, y, z, height=9, style="brick", color=None, trim=None)',
    f"A chimney `height` plates tall before its cap. {_BASE} Stand it on the studs of the roof ridge or of a flat "
    "roof, or run it up the outside of a wall from the ground.", ("color", "trim"), sized=True)
COLUMN = _helper(
    "column", COLUMNS, 'column(x, y, z, height=18, style="round", color=None, trim=None)',
    f"A column or post about `height` plates tall, to carry a porch roof or stand on its own. {_BASE}",
    ("color", "trim"), sized=True)
HELPERS = (PLANT, LAMP, CHIMNEY, COLUMN)
