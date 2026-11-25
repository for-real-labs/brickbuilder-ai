"""Ready-made arches.

An arch part stands on its legs and spans the gap between them, so an arched opening needs no
lintel worked out by hand. A style is one arch part, or two half arches that lean in from either
side. ``height`` raises it on a pair of piers.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import Frame, Helper, choice, column, local_rect, need, whole


@dataclass(frozen=True)
class ArchStyle:
    part: str
    wide: int  # studs the whole arch spans
    tall: int  # plates
    halves: bool = False  # two parts leaning in from the sides, instead of one
    leg: int = 1  # studs each leg stands on
    deep: int = 1
    single: bool = False  # one half arch on its own: a buttress


STYLES: dict[str, ArchStyle] = {
    "flat": ArchStyle("3659", 4, 3),
    "small": ArchStyle("4490", 3, 3),
    "raised": ArchStyle("6182", 4, 6),
    "wide": ArchStyle("92950", 6, 3),
    "thick": ArchStyle("15254", 6, 6),
    "curved": ArchStyle("6183", 6, 6),
    "long": ArchStyle("16577", 8, 6),
    "grand": ArchStyle("18838", 12, 9),
    "ornate": ArchStyle("2145", 6, 15, deep=2),
    "pointed": ArchStyle("6005", 6, 6, halves=True, leg=2),
    "gothic": ArchStyle("13965", 6, 9, halves=True, leg=2),
    "tall_gothic": ArchStyle("80543", 8, 9, halves=True, leg=2),
    "bow": ArchStyle("76768", 10, 12, halves=True, leg=2),
    "sweep": ArchStyle("6060", 12, 10, halves=True, leg=2),
    "buttress": ArchStyle("13965", 3, 9, halves=True, leg=2, single=True),
    "flying_buttress": ArchStyle("76768", 5, 12, halves=True, leg=2, single=True),
}


def build_arch(kit: Kit, x, y, z, style="flat", color="Light_Bluish_Grey", height=0, facing="front") -> list[int]:
    """An arch whose span has its min corner at (x, z), raised ``height`` plates on piers."""
    look = STYLES[choice(style, STYLES, "style", "arch")]
    x, z = whole(x, "x", "arch"), whole(z, "z", "arch")
    height = whole(height, "height", "arch", 0, 150)
    choice(facing, ("front", "back", "left", "right"), "facing", "arch")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("arch() needs a number of plates for y")
    part, code = need(kit, look.part, color, "arch", "arch part of this style")
    frame = Frame(kit, x, y, z, look.wide, look.deep, facing)
    placed: list[int] = []
    legs = local_rect(0, 0, look.leg, look.deep)
    if not look.single:
        legs |= local_rect(look.wide - look.leg, 0, look.wide, look.deep)
    if height:
        placed += column(frame, legs, 0, height, color, "arch")
    if not look.halves:
        placed.append(frame.place(part, code, 0, height, 0))
        return placed
    half = look.wide if look.single else look.wide // 2
    # A half arch lies along z with its leg at the low end: a quarter turn stands that leg at the left.
    placed.append(frame.place(part, code, 0, height, 0, rot=90))
    if not look.single:
        placed.append(frame.place(part, code, half, height, 0, rot=270))
    return placed


HELPER = Helper(
    name="arch", build=build_arch,
    signature='arch(x, y, z, style="flat", color="Light_Bluish_Grey", height=0, facing="front")',
    summary="An arch over an opening, or a buttress. (x, z) is the min corner of its span and y its base, on studs. "
            "`height` stands it on two piers that many plates tall, so an arched doorway is one call. The note "
            "after each style is its span in studs x its own height in plates; it is one stud deep unless the note "
            "says more. It spans along x when `facing` is front or back and along z when left or right. A wall "
            "can go on above it.",
    styles=tuple(STYLES),
    notes={name: f"{look.wide}x{look.tall}" + (f", {look.deep} deep" if look.deep > 1 else "")
           for name, look in STYLES.items()},
)
