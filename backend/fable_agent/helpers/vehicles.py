"""Ready-made vehicle bases: the floor of a car or truck with its axles under it.

A model that builds a car by hand has to get three things right at once: wheels that touch the
ground, a floor that every axle is joined to, and room for the tyres. Official sets solve it in two
ways, and a base here is one of them (the numbers are in docs/fable-helpers.md):

* **tucked**: a body four studs wide with its wheels under it. Each axle is a two-pin holder, a
  spine plate runs the length of the car over the holders, and a mudguard with an arch sits on the
  spine over each axle, so the tyres have room. The floor is filled in level with the mudguards.
* **outboard**: wheels outside the body, for any width. Each axle is a pair of holders or bricks at
  the sides. Plates laid across them, then plates laid along the whole length, make a floor that
  every axle is joined to.

``y`` is the ground the tyres stand on. Each style's note gives its deck: how many plates above
``y`` the top of the floor is, where the body starts.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .cars import BODY, STYLES as WHEELS, build_wheels
from .common import BRICK, Frame, Helper, brick_color, bridge, choice, column, local_rect, span_lengths, stocked, whole

MUDGUARD = "60212"  # 2 x 4 with an arch over each wheel and studs on top
MAX_TUCKED, MAX_LENGTH = 16, 30


@dataclass(frozen=True)
class Base:
    wide: int
    length: int
    axles: tuple[tuple[int, str], ...]  # (studs from the front edge, or from the back when negative; wheels style)
    color: str = "Dark_Bluish_Grey"


def _pair(wheels: str, front: int = 1, back: int = -3) -> tuple[tuple[int, str], ...]:
    return (front, wheels), (back, wheels)


STYLES: dict[str, Base] = {
    "city": Base(4, 10, _pair("small")),
    "hatchback": Base(4, 8, _pair("smooth")),
    "sedan": Base(4, 12, _pair("small", 1, -4)),
    "classic": Base(4, 10, _pair("classic")),
    "kart": Base(4, 6, _pair("small", 0, -2)),
    "limo": Base(4, 16, _pair("spoked", 2, -4)),
    "van": Base(4, 12, _pair("spoked", 1, -3)),
    "buggy": Base(4, 8, _pair("outboard")),
    "cart": Base(4, 8, _pair("wagon"), color="Reddish_Brown"),
    "trailer": Base(4, 8, ((3, "axle_4"),)),
    "racer": Base(4, 14, _pair("sport", 2, -3), color="Black"),
    "sports": Base(6, 14, _pair("sport", 2, -4), color="Black"),
    "street": Base(6, 14, _pair("street", 2, -4)),
    "suv": Base(6, 14, _pair("offroad", 2, -4)),
    "pickup": Base(6, 16, _pair("medium", 2, -5)),
    "bus": Base(6, 24, _pair("medium", 3, -7)),
    "camper": Base(6, 20, _pair("street", 2, -6)),
    "truck": Base(6, 20, _pair("truck", 2, -5)),
    "lorry": Base(6, 26, ((2, "truck"), (-12, "truck"), (-5, "truck"))),
    "wide_truck": Base(8, 24, _pair("truck", 3, -6)),
    "monster": Base(6, 14, _pair("balloon", 1, -3), color="Black"),
    "tractor": Base(6, 12, ((1, "medium"), (-4, "tall")), color="Green"),
    "hot_rod": Base(4, 12, ((1, "outboard"), (-3, "medium")), color="Black"),
}
TOP = {"holder": 1, "singles": 1, "pins": BRICK, "axle": BRICK}  # plates from a carrier's base to its studs


def _tucked(wheels: str) -> bool:
    look = WHEELS[wheels]
    return look.mount == "holder" and look.holder == "4600"


def _carried(wheels: str, wide: int, at: int) -> set[tuple[int, int]]:
    """The cells whose studs carry the floor over one outboard axle."""
    look = WHEELS[wheels]
    if look.mount == "holder":  # a 1 x 4 plate with its wheels beyond its ends
        return local_rect(0, at, wide, at + 1)
    edge = 2 if look.mount == "singles" else 1
    return local_rect(0, at, edge, at + 2) | local_rect(wide - edge, at, wide, at + 2)


def deck(style: str, wheels: str | None = None) -> int:
    """Plates from the ground to the top of a style's floor."""
    look = STYLES[style]
    styles = [wheels or name for _, name in look.axles]
    if all(_tucked(name) for name in styles):
        return max(WHEELS[name].drop for name in styles) + 4
    return max(WHEELS[name].drop + TOP[WHEELS[name].mount] for name in styles) + 2


def _kind(wheels: str) -> str:
    """How an axle is carried: tucked under the body, on plates beside it, or on bricks beside it."""
    look = WHEELS[wheels]
    if look.mount == "caster":
        return "caster"
    return "tucked" if _tucked(wheels) else "brick" if TOP[look.mount] == BRICK else "plate"


def _fits(wheels: str, style: str) -> bool:
    """Whether a style can take these wheels in place of its own without changing how it is built."""
    look = STYLES[style]
    narrow = WHEELS[wheels].mount != "holder" or look.wide == BODY
    return narrow and all(_kind(wheels) == _kind(own) for _, own in look.axles)


def build_chassis(kit: Kit, x, y, z, style="city", length=None, color=None, wheels=None, rim=None,
                  facing="front") -> list[int]:
    """A vehicle's floor on its axles. (x, z) is the min corner of the floor; the tyres stand on ``y``."""
    look = STYLES[choice(style, STYLES, "style", "chassis")]
    x, z = whole(x, "x", "chassis"), whole(z, "z", "chassis")
    choice(facing, ("front", "back", "left", "right"), "facing", "chassis")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("chassis() needs a number of plates for y")
    if wheels is not None:
        choice(wheels, WHEELS, "wheels", "chassis")
        if not _fits(wheels, style):
            fitting = ", ".join(name for name in WHEELS if _fits(name, style))
            raise KitError(f"chassis() style {style} cannot carry {wheels} wheels; choose from: {fitting}")
    names = [wheels or name for _, name in look.axles]
    tucked = _tucked(names[0])
    spans = [2 if WHEELS[name].mount != "holder" or _tucked(name) else 1 for name in names]
    shortest = sum(spans) + 2 * (len(spans) - 1)
    longest = MAX_TUCKED if tucked else MAX_LENGTH
    length = whole(look.length if length is None else length, "length", "chassis", max(4, shortest), longest)
    color = look.color if color is None else color
    tone = brick_color(kit, color, "chassis", "plate")

    # Axles keep their distance from the ends when the length changes, and never overlap.
    starts = []
    for (at, _), span in zip(look.axles, spans):
        starts.append(min(max(0, at if at >= 0 else length + at), length - span))
    for i in range(1, len(starts)):
        starts[i] = max(starts[i], starts[i - 1] + spans[i - 1] + 1)
    if starts[-1] + spans[-1] > length:
        raise KitError(f"chassis() style {style} needs more length for its {len(starts)} axles")

    # A floor the catalog's plates cannot make is refused here, before anything is placed.
    if tucked:
        span_lengths(kit, "plate", 2, length, tone, "chassis")
    else:
        for thick in {2, 1} if look.wide % 2 else {2}:
            _cut(kit, thick, length, tone)

    drops = [WHEELS[name].drop for name in names]
    placed: list[int] = []
    frame = Frame(kit, x, y, z, look.wide, length, facing)

    def axle(name: str, at: int, base) -> list[int]:
        wx, wz = frame.rect(0, at, look.wide, 2)
        return build_wheels(kit, int(round(wx)), y + base, int(round(wz)), style=name, width=look.wide, color=rim,
                            facing=facing)

    if tucked:
        base = max(drops)  # the holders' base, in plates above the ground
        for name, at in zip(names, starts):
            placed += axle(name, at, base)
        placed += bridge(frame, 1, 0, 3, length, base + 1, tone, "chassis", across="z")  # the spine
        rows = set()
        guard, square = stocked(kit, MUDGUARD, color), kit.plain_part("plate", 2, 2, tone)
        for at in starts:
            rows |= local_rect(0, at, look.wide, at + 2)
            if guard is not None and square is not None:
                placed.append(frame.place(MUDGUARD, guard, 0, base + 2, at))
                # A 2 x 2 plate fills the mudguard's middle, level with its arches. The checks model the
                # arches' inner walls as thicker than they are, so this fit is declared.
                placed.append(frame.place(square[0], square[1], 1, base + 3, at, allow_overlap=True))
            else:  # no mudguard part: the body stays two wide over the wheels, then closes above them
                placed += frame.fill(local_rect(1, at, 3, at + 2), base + 2, tone, kind="plate")
                placed += bridge(frame, 0, at, look.wide, at + 2, base + 3, tone, "chassis", across="x")
        floor = local_rect(0, 0, look.wide, length) - rows
        if floor:
            placed += frame.fill(floor, base + 2, tone, kind="plate", layers=2)
        return placed

    # Outboard: carriers at each axle, raised to one level, then plates across and plates along.
    tops = [drop + TOP[WHEELS[name].mount] for name, drop in zip(names, drops)]
    level = max(tops)
    for name, at, drop, top in zip(names, starts, drops, tops):
        placed += axle(name, at, drop)
        if top < level:
            placed += column(Frame(kit, x, y + top, z, look.wide, length, facing), _carried(name, look.wide, at), 0,
                             level - top, color, "chassis")
    placed += bridge(frame, 0, 0, look.wide, length, level, tone, "chassis", across="x")
    placed += _lengthwise(frame, look.wide, length, level + 1, tone)
    return placed


def _cut(kit: Kit, thick: int, length: int, color) -> list[int]:
    """Stocked plate lengths that add up to ``length``, as few and as long as the catalog allows."""
    if length == 0:
        return []
    for size in range(min(length, 16), 1, -1):
        if kit.plain_part("plate", thick, size, color) and (length - size == 0 or length - size >= 2):
            try:
                return [size] + _cut(kit, thick, length - size, color)
            except KitError:
                continue
    raise KitError(f"chassis() cannot lay a floor {length} studs long with the plates in the catalog")


def _lengthwise(frame: Frame, wide: int, length: int, ly, color) -> list[int]:
    """Plates that each run the whole length, with their seams at alternate ends so the floor is one piece."""
    kit = frame.kit
    widths = [2] * (wide // 2)
    if wide % 2:
        widths.insert(min(1, len(widths)), 1)
    placed, at = [], 0
    for number, thick in enumerate(widths):
        pieces = _cut(kit, thick, length, color)
        offset = 0
        for size in (pieces if number % 2 == 0 else pieces[::-1]):
            part, _ = kit.plain_part("plate", thick, size, color)
            turned = round(kit.part(part).w) != thick
            placed.append(frame.place(part, color, at, ly, offset, rot=90 if turned else 0))
            offset += size
        at += thick
    return placed


def _note(style: str) -> str:
    look = STYLES[style]
    outside = "" if all(_tucked(name) for _, name in look.axles) else ", wheels outside"
    return f"{look.wide}x{look.length}, deck {deck(style)}{outside}"


HELPER = Helper(
    name="chassis", build=build_chassis,
    signature='chassis(x, y, z, style="city", length=None, color=None, wheels=None, rim=None, facing="front")',
    summary="The rolling base of a car, truck, bus or trailer: a floor with every axle, wheel and tyre joined "
            "under it. Start every wheeled vehicle with it, then build the body on the floor's studs. (x, z) is "
            "the min corner of the floor and y the ground the tyres stand on. The note after each style is the "
            "floor's studs across x studs long, and its deck: the plates from y up to the top of the floor, "
            "where the body starts. `length` changes how long it is. The vehicle drives towards `facing`, and "
            "its length runs along z when that is front or back and along x when left or right. Styles marked "
            "`wheels outside` have their tyres beside the floor, about one stud out at each side. `wheels` puts "
            "another wheels() style on every axle; the error names the ones a style can take, and the deck moves "
            "by the difference between the two styles' `below` notes. `rim` is the rims' color, `color` the "
            "floor's. The "
            "tyres are joined to a road or baseplate that is already under them, so lay that before the vehicle.",
    styles=tuple(STYLES),
    notes={style: _note(style) for style in STYLES},
)
