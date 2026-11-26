"""Ready-made car parts: wheels, windscreens and seats.

Vehicles are about one build in six. Their hard parts are joints that studs do not make: a wheel
on its pin, a tyre on its rim, a steering wheel on a side stud. The checks cannot see those, so a
model that guesses the offset gets a wheel that floats beside the car. Every offset here is the
one customers' models use most (see docs/fable-helpers.md), and the helper records each joint.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..kit import Kit, KitError
from .common import BRICK, Frame, Helper, brick_color, choice, local_rect, need, stocked, whole

SAME = (1, 0, 0, 0, 1, 0, 0, 0, 1)
TURN_LEFT = (0, 0, 1, 0, 1, 0, -1, 0, 0)  # a wheel on a pin that points to the holder's -x side
TURN_RIGHT = (0, 0, -1, 0, 1, 0, 1, 0, 0)
HALF_TURN = (-1, 0, 0, 0, 1, 0, 0, 0, -1)
QUARTER = (0, 0, -1, 0, 1, 0, 1, 0, 0)  # turns an axle's length onto a brick's axle hole


@dataclass(frozen=True)
class Wheel:
    rim: str
    tyre: str | None
    tyre_offset: tuple[int, int, int] = (0, 0, 0)


@dataclass(frozen=True)
class WheelStyle:
    mount: str  # holder | singles | pins | axle | caster
    wheel: Wheel
    holder: str = "4600"
    reach: int = 30  # LDraw units from the holder's middle to each rim
    drop: int = 2  # plates the tyres reach below the base
    out: int = 20  # on an axle: LDraw units from the middle of the brick it runs through to the rim
    rim_offset: tuple[int, int, int] = (0, 10, -20)  # on a pin brick
    rim_turn: tuple = SAME
    color: str = "Light_Bluish_Grey"


TINY = Wheel("4624", "87414")
STYLES: dict[str, WheelStyle] = {
    "small": WheelStyle("holder", TINY),
    "axle_4": WheelStyle("holder", TINY, holder="2926", reach=50),
    "smooth": WheelStyle("holder", Wheel("4624", "59895")),
    "hubcap": WheelStyle("holder", Wheel("93594", "50951"), holder="2926", reach=50),
    "spoked": WheelStyle("holder", Wheel("42610", "92409")),
    "classic": WheelStyle("holder", Wheel("6014b", "87697", (0, 0, -6)), drop=3),
    "spoked_axle": WheelStyle("holder", Wheel("42610", "92409"), holder="2926", reach=50),
    "classic_axle": WheelStyle("holder", Wheel("6014b", "87697", (0, 0, -6)), holder="2926", reach=50, drop=3),
    "outboard_classic": WheelStyle("singles", Wheel("6014b", "87697", (0, 0, -6)), holder="4488", drop=3),
    "outboard": WheelStyle("singles", TINY, holder="4488"),
    "wagon": WheelStyle("singles", Wheel("4489b", None), holder="4488", drop=5, color="Reddish_Brown"),
    "medium": WheelStyle("pins", Wheel("13971", "61254")),
    "sport": WheelStyle("pins", Wheel("66727", "18977", (0, 0, -6))),
    "street": WheelStyle("pins", Wheel("55981", "89201"), rim_offset=(0, 10, -30), rim_turn=HALF_TURN),
    "offroad": WheelStyle("pins", Wheel("55981", "92402"), rim_offset=(0, 10, -30), rim_turn=HALF_TURN, drop=3),
    "truck": WheelStyle("axle", Wheel("56904", "56898"), drop=5),
    # Added from official sets (docs/fable-helpers.md): the large rim with its three tyres, and trolley wheels.
    "big": WheelStyle("axle", Wheel("56145", "44309"), out=40, drop=5),
    "tall": WheelStyle("axle", Wheel("56145", "15413"), out=40, drop=6),
    "balloon": WheelStyle("axle", Wheel("56145", "55976"), out=45, drop=7),
    "caster": WheelStyle("caster", Wheel("2496", None), holder="2655", drop=2, color="Black"),
}
PIN_BRICK, AXLE_BRICK = "2458", "32064a"
# Axle, half its length. An axle carries a wheel when its end stops no more than SHORT before the
# middle of the rim and no more than LONG past it.
AXLES = (("4519", 30), ("3705", 40), ("32073", 50), ("3706", 60), ("44294", 70), ("3707", 80), ("60485", 90),
         ("3737", 100), ("3708", 120))
SHORT, LONG = 5, 10
UNQUARTER = (0, 0, 1, 0, 1, 0, -1, 0, 0)  # QUARTER undone: from a brick's frame into its axle's
BODY = 4  # studs across the body that the one-plate holders sit under


def _wheel(kit: Kit, host: int, wheel: Wheel, offset, turn, color, tyre_color, note="wheel on its pin") -> list[int]:
    rim, code = need(kit, wheel.rim, color, "wheels", "wheel of this style")
    placed = [kit.attach(rim, code, host, offset, turn, note)]
    if wheel.tyre is not None:
        tone = stocked(kit, wheel.tyre, tyre_color)
        if tone is not None:
            placed.append(kit.attach(wheel.tyre, tone, placed[0], wheel.tyre_offset, SAME, "tyre on its rim"))
    return placed


def _axle_for(kit: Kit, reach: float) -> tuple[str, int] | None:
    """The longest stocked axle, with its color, whose ends sit in rims ``reach`` from its middle."""
    fits = [(part, stocked(kit, part, "Black")) for part, half in AXLES if reach - SHORT <= half <= reach + LONG]
    fits = [(part, tone) for part, tone in fits if tone is not None]
    return fits[-1] if fits else None


def _times(first, second) -> tuple:
    """The product of two row-major rotations."""
    return tuple(sum(first[3 * row + k] * second[3 * k + col] for k in range(3)) for row in range(3) for col in range(3))


def _sink(kit: Kit, part: str) -> float:
    """How far a wheel holder hangs below the plate that is its top: its studs end up one plate above y."""
    tops = [stud[2] for stud in kit.part(part).studs]
    return 1 - (min(tops) if tops else 1)


def build_wheels(kit: Kit, x, y, z, style="small", width=4, color=None, tyre="Black", facing="front") -> list[int]:
    """One axle: two wheels with what carries them. The car drives towards ``facing``."""
    placed = _axle(kit, x, y, z, style, width, color, tyre, facing)
    kit.stand(placed, "tyres standing on it")  # a road or baseplate already under the wheels
    return placed


def _axle(kit: Kit, x, y, z, style, width, color, tyre, facing) -> list[int]:
    look = STYLES[choice(style, STYLES, "style", "wheels")]
    x, z = whole(x, "x", "wheels"), whole(z, "z", "wheels")
    width = whole(width, "width", "wheels", 4, 16)
    choice(facing, ("front", "back", "left", "right"), "facing", "wheels")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("wheels() needs a number of plates for y")
    color = look.color if color is None else color
    base = brick_color(kit, "Light_Bluish_Grey", "wheels", "plate")
    placed: list[int] = []

    if look.mount == "caster":
        holder, tone = need(kit, look.holder, base, "wheels", "wheel holder")
        frame = Frame(kit, x, y, z, 2, 2, facing)
        host = frame.place(holder, tone, 0, _sink(kit, holder), 0)
        rim, code = need(kit, look.wheel.rim, color, "wheels", "wheel of this style")
        return [host, kit.attach(rim, code, host, (0, 14, 0), SAME, "trolley wheels clipped in their holder")]

    if look.mount == "holder":
        holder, tone = need(kit, look.holder, base, "wheels", "wheel holder")
        _, wide, deep, _ = kit.measure(holder)
        # Centered under a body four studs wide, so that the holder's studs fall on the grid.
        frame = Frame(kit, x, y, z, BODY, 2, facing)
        host = frame.place(holder, tone, (BODY - wide) / 2, _sink(kit, holder), 0)
        placed.append(host)
        placed += _wheel(kit, host, look.wheel, (-look.reach, 5, 0), TURN_LEFT, color, tyre)
        placed += _wheel(kit, host, look.wheel, (look.reach, 5, 0), TURN_RIGHT, color, tyre)
        return placed

    frame = Frame(kit, x, y, z, width, 2, facing)
    if look.mount == "singles":
        holder, tone = need(kit, look.holder, base, "wheels", "wheel holder")
        for lx, turned, offset, turn in ((0, 180, (30, 5, 0), TURN_RIGHT), (width - 2, 0, (30, 5, 0), TURN_RIGHT)):
            host = frame.place(holder, tone, lx - (0.7 if turned else 0), _sink(kit, holder), 0, rot=turned)
            placed.append(host)
            placed += _wheel(kit, host, look.wheel, offset, turn, color, tyre)
        return placed

    brick = PIN_BRICK if look.mount == "pins" else AXLE_BRICK
    part, tone = need(kit, brick, base, "wheels", "brick that carries the wheel")
    if look.mount == "pins":
        # A 1 x 2 brick with a pin stands at each side of the body, its pin pointing outwards.
        for lx, turned in ((0, 90), (width - 1, 270)):
            _, wide, _, _ = kit.measure(part, rot=turned)
            host = frame.place(part, tone, lx - (wide - 1 if turned == 90 else 0), 0, 0, rot=turned)
            placed.append(host)
            placed += _wheel(kit, host, look.wheel, look.rim_offset, look.rim_turn, color, tyre)
        return placed

    # An axle through a brick at each side of the body, with a wheel on each end. Every joint is
    # recorded between the two parts that really meet: brick and axle, axle and wheel.
    hosts = [frame.place(part, tone, lx, 0, 0, rot=90) for lx in (0, width - 1)]
    placed += hosts
    middle = (width - 1) * 10  # LDraw units from the first brick to the middle of the body
    reach = middle + look.out  # from the middle of the body to each rim
    through = _axle_for(kit, reach)
    if through is not None:  # one axle from rim to rim
        shaft = kit.attach(*through, hosts[0], (0, 10, middle), QUARTER, "axle through the axle hole")
        kit.connect(shaft, hosts[1], "the same axle through this brick")
        shafts = [(shaft, -reach), (shaft, reach)]
    else:  # a body too wide for one axle: a short one through each brick
        stub = _axle_for(kit, look.out)
        if stub is None:
            raise KitError(f"wheels() has no axle for the {style} style at this width; use another style")
        # A brick's own z axis points across the body, so the first brick's wheel is on its minus side.
        shafts = [(kit.attach(*stub, host, (0, 10, 0), QUARTER, "axle through the axle hole"), side * look.out)
                  for host, side in zip(hosts, (-1, 1))]
    placed += sorted({shaft for shaft, _ in shafts})
    for (shaft, along), turn in zip(shafts, (HALF_TURN, SAME)):
        placed += _wheel(kit, shaft, look.wheel, (along, 0, 0), _times(UNQUARTER, turn), color, tyre,
                         "wheel on its axle")
    return placed


WHEELS = Helper(
    name="wheels", build=build_wheels,
    signature='wheels(x, y, z, style="small", width=4, color=None, tyre="Black", facing="front")',
    summary="One axle of a vehicle: two wheels with tyres and the part that carries them, all joined. For the "
            "whole rolling base of a car or truck use chassis() instead; call this once per axle for anything "
            "else on wheels. `facing` is the way the vehicle drives; the axle lies across that. (x, z) is the min "
            "corner of the body above the axle, `width` studs across (4 for the styles not marked `any width`, "
            "2 for caster) and 2 along, and y the base of the part that carries the wheels: build on its studs, "
            "one plate above y, or one brick above y for the `any width` styles. The tyres reach below y by the "
            "plates the note gives, so set y that far above the ground. `any width` styles put a wheel outside "
            "each side of the body. The others tuck both wheels under the body, where the tyres rise about 2 "
            "plates above y: keep the body 2 studs wide over them for its first 2 plates. `color` is the rim. "
            "Wheels are joined to a road or baseplate that is already under them, so lay that first.",
    styles=tuple(STYLES),
    notes={name: {"holder": "", "caster": "2 wide, "}.get(look.mount, "any width, ") + f"{look.drop} below"
           for name, look in STYLES.items()},
)

# ----- windscreens ---------------------------------------------------------------

SCREENS = {
    "classic": "3823", "inverted": "4284", "upright": "4594", "wide": "4176", "train": "13760",
    "panoramic": "57783", "low": "2437", "tall": "84954", "curved": "62360", "raked": "92583", "bus": "20684",
    "flat": "6238a", "roll_cage": "47758", "narrow": "6070", "sport": "18972", "canopy": "18973", "coupe": "6152b",
    "wide_low": "65633", "wide_curved": "65632", "wraparound": "41751", "bubble": "47844", "cab": "94531",
}
SCREEN_SIZES = {
    "classic": (4, 2, 6), "inverted": (4, 2, 6), "upright": (4, 2, 6), "wide": (6, 2, 6), "train": (6, 2, 6),
    "panoramic": (4, 3, 4), "low": (4, 3, 4), "tall": (4, 3, 9), "curved": (6, 3, 3), "raked": (6, 3, 6),
    "bus": (8, 3, 9), "flat": (4, 4, 3), "roll_cage": (4, 4, 3), "narrow": (2, 5, 5), "sport": (4, 5, 5),
    "canopy": (4, 6, 4), "coupe": (4, 6, 4), "wide_low": (6, 6, 4), "wide_curved": (6, 6, 5),
    "wraparound": (6, 8, 6), "bubble": (4, 10, 6), "cab": (6, 12, 18),
}


def build_windscreen(kit: Kit, x, y, z, style="classic", color="Trans_Clear", facing="front") -> list[int]:
    """A windscreen whose footprint has its min corner at (x, z), its glass sloping down towards ``facing``."""
    part = SCREENS[choice(style, SCREENS, "style", "windscreen")]
    x, z = whole(x, "x", "windscreen"), whole(z, "z", "windscreen")
    choice(facing, ("front", "back", "left", "right"), "facing", "windscreen")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("windscreen() needs a number of plates for y")
    part, code = need(kit, part, color, "windscreen", "windscreen of this style")
    _, wide, deep, _ = kit.measure(part, facing="front")
    frame = Frame(kit, x, y, z, wide, deep, facing)
    return [frame.place(part, code, 0, 0, 0, facing="front")]


WINDSCREEN = Helper(
    name="windscreen", build=build_windscreen,
    signature='windscreen(x, y, z, style="classic", color="Trans_Clear", facing="front")',
    summary="A vehicle windscreen or canopy, one part, in the stocked transparent color closest to `color`. "
            "(x, z) is the min corner of its footprint and y its base; it stands on the studs under it. Its glass "
            "slopes down towards `facing`, the way the vehicle drives. The note after each style is its size when "
            "facing front: studs wide x studs deep x plates tall.",
    styles=tuple(SCREENS),
    notes={name: "x".join(str(v) for v in size) for name, size in SCREEN_SIZES.items()},
)

# ----- seats -----------------------------------------------------------------------

SEAT, WHEEL, SIDE_STUD, LEVER_BASE, LEVER, ROUND_PLATE = "4079", "16091", "87087", "4592", "4593", "4073"
ON_SIDE_STUD = ((0, 10, -18), (-1, 0, 0, 0, 0, 1, 0, 1, 0))  # a steering wheel on the side stud of 87087


@dataclass(frozen=True)
class Cabin:
    wide: int
    deep: int
    seats: tuple[tuple[int, int], ...] = ()  # (lx, lz) of each 2 x 2 seat
    wheel: int | None = None  # the column the steering wheel stands in front of
    levers: tuple[tuple[int, int], ...] = ()
    benches: tuple[int, ...] = ()  # lz of each bench across the full width


CABINS: dict[str, Cabin] = {
    "single": Cabin(2, 3, ((0, 0),)),
    "pair": Cabin(4, 3, ((0, 0), (2, 0))),
    "driver_left": Cabin(2, 5, ((0, 2),), wheel=0),
    "driver_right": Cabin(2, 5, ((0, 2),), wheel=1),
    "front_row_left": Cabin(4, 5, ((0, 2), (2, 2)), wheel=0),
    "front_row_right": Cabin(4, 5, ((0, 2), (2, 2)), wheel=3),
    "sedan_left": Cabin(4, 8, ((0, 2), (2, 2), (0, 5), (2, 5)), wheel=0),
    "sedan_right": Cabin(4, 8, ((0, 2), (2, 2), (0, 5), (2, 5)), wheel=3),
    "cockpit": Cabin(3, 5, ((0, 2),), wheel=0, levers=((2, 2),)),
    "pilot": Cabin(4, 3, ((1, 0),), levers=((0, 0), (3, 0))),
    "tandem": Cabin(2, 8, ((0, 2), (0, 5)), wheel=0),
    "bench": Cabin(4, 3, benches=(0,)),
    "taxi": Cabin(4, 8, ((0, 2), (2, 2)), wheel=0, benches=(5,)),
    "van": Cabin(4, 11, ((0, 2), (2, 2), (0, 5), (2, 5), (0, 8), (2, 8)), wheel=0),
    "bus": Cabin(4, 9, ((0, 0), (2, 0), (0, 3), (2, 3), (0, 6), (2, 6))),
    "minibus": Cabin(4, 14, ((0, 2), (2, 2), (0, 5), (2, 5), (0, 8), (2, 8), (0, 11), (2, 11)), wheel=0),
}


def build_seats(kit: Kit, x, y, z, style="driver_left", color="Dark_Bluish_Grey", trim="Black",
                facing="front") -> list[int]:
    """Seats, and a steering wheel where the style has one, for people looking towards ``facing``."""
    look = CABINS[choice(style, CABINS, "style", "seats")]
    x, z = whole(x, "x", "seats"), whole(z, "z", "seats")
    choice(facing, ("front", "back", "left", "right"), "facing", "seats")
    if isinstance(y, bool) or not isinstance(y, (int, float)):
        raise KitError("seats() needs a number of plates for y")
    frame = Frame(kit, x, y, z, look.wide, look.deep, facing)
    placed: list[int] = []
    seat = stocked(kit, SEAT, color)
    for lx, lz in look.seats:
        if seat is not None:
            placed.append(frame.place(SEAT, seat, lx, 0, lz, facing="front"))
        else:  # no seat part here: a block with a backrest
            placed += frame.fill(local_rect(lx, lz, lx + 2, lz + 2), 0, brick_color(kit, color, "seats", "plate"),
                                 kind="plate")
            placed += frame.fill(local_rect(lx, lz + 2, lx + 2, lz + 3), 0, brick_color(kit, color, "seats"))
    for lz in look.benches:
        placed += frame.fill(local_rect(0, lz, look.wide, lz + 2), 0, brick_color(kit, color, "seats", "plate"),
                             kind="plate", layers=2)
        placed += frame.fill(local_rect(0, lz + 2, look.wide, lz + 3), 0, brick_color(kit, color, "seats"), layers=2)
    if look.wheel is not None:
        dash, wheel = stocked(kit, SIDE_STUD, trim), stocked(kit, WHEEL, trim)
        placed += frame.fill({(look.wheel, 0)}, 0, brick_color(kit, trim, "seats", "plate"), kind="plate")
        if dash is not None:
            # The brick's side stud points back at the driver; the steering wheel sits on it.
            host = frame.place(SIDE_STUD, dash, look.wheel, 1, 0, rot=180)
            placed.append(host)
            if wheel is not None:
                placed.append(kit.attach(WHEEL, wheel, host, *ON_SIDE_STUD, "steering wheel on a side stud"))
    for lx, lz in look.levers:
        base, stick = stocked(kit, LEVER_BASE, trim), stocked(kit, LEVER, trim)
        if base is not None:
            host = frame.place(LEVER_BASE, base, lx, 0, lz)
            placed.append(host)
            if stick is not None:
                placed.append(kit.attach(LEVER, stick, host, (0, 0, 0), SAME, "lever in its base"))
    return placed


SEATS = Helper(
    name="seats", build=build_seats,
    signature='seats(x, y, z, style="driver_left", color="Dark_Bluish_Grey", trim="Black", facing="front")',
    summary="The inside of a vehicle: seats, and for the driver styles a steering wheel on a dashboard brick, for "
            "people looking towards `facing`. (x, z) is the min corner of the footprint and y its base, the cabin "
            "floor, which must have studs. The note after each style is its footprint when facing front, studs "
            "wide x studs deep. `color` is the seats, `trim` the steering wheel and levers.",
    styles=tuple(CABINS),
    notes={name: f"{look.wide}x{look.deep}" for name, look in CABINS.items()},
)

HELPERS = (WHEELS, WINDSCREEN, SEATS)
