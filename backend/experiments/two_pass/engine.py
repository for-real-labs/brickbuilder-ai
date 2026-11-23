"""Compile oriented, constructive stud geometry into supplier-backed LDraw placements."""

from collections import Counter

# Width and depth in studs, height in plates. Part origin is top-center.
BRICKS = [
    (4, 2, "3001"),
    (3, 2, "3002"),
    (2, 2, "3003"),
    (6, 1, "3009"),
    (4, 1, "3010"),
    (3, 1, "3622"),
    (2, 1, "3004"),
    (1, 1, "3005"),
]
PLATES = [
    (8, 4, "3035"),
    (6, 4, "3032"),
    (4, 4, "3031"),
    (6, 2, "3795"),
    (4, 2, "3020"),
    (3, 2, "3021"),
    (2, 2, "3022"),
    (6, 1, "3666"),
    (4, 1, "3710"),
    (3, 1, "3623"),
    (2, 1, "3023"),
    (1, 1, "3024"),
]
ROTATIONS = [
    "1 0 0 0 1 0 0 0 1",
    "0 0 1 0 1 0 -1 0 0",
    "-1 0 0 0 1 0 0 0 -1",
    "0 0 -1 0 1 0 1 0 0",
]
SHAPES = {
    "box",
    "shell",
    "ellipsoid",
    "cylinder",
    "cone",
    "gableX",
    "gableZ",
    "cut",
    "circlecut",
}
GUIDE = """Design an editable physical LEGO sculpture matching the original brief, including its most distinctive details. Output only a compact JSON array of operations. Coordinates: x increases right in the front view, z increases toward the BACK, y increases upward. Horizontal distances are studs, vertical distances PLATES (3 plates per brick). y=0 ground. Each shape row is [kind,color,x,z,y,width,depth,height], integer MINIMUM left/front/bottom corners; sizes 1..64. Later shapes overwrite cells. box=solid, shell=vertical perimeter walls open top/bottom, ellipsoid=smooth oval, cylinder=vertical oval drum, cone=tapers to top, gableX=ridge parallel X, gableZ=ridge parallel Z. cut or circlecut erases a volume. The compiler fills shapes with real interlocking plates/bricks. For small details, add [\"part\",color,xCenter,zCenter,yTop,\"ldrawId\",quarterTurns] using half-studs if needed and local part origin (top of brick); these explicit parts do not subtract solids, provide clearance. Use known specialized parts for features when helpful. Repeat ANY one row by [\"repeat\",count,dx,dz,dy,row]. Include geometric depth, distinctive silhouette, color markings, facial or architectural detail, supported joins. Build economical at modest scale. Use LDraw solid colors: 0 black,1 blue,2 green,4 red,7 light gray,14 yellow,15 white,19 tan,22 purple,25 orange,28 dark tan,70 reddish brown,71 light bluish gray,72 dark bluish gray,78 skin,272 dark blue,288 dark green,484 dark orange. Avoid unnecessary plinths. For pitched roofs prefer real sloped courses ["roofX" or "roofZ",color,x,z,yBottom,lengthAlongRidge,evenCrossSpan] with sizes >=4. Height is 3*(crossSpan/2-1) plates. Use a supported platform underneath; this routine constructs the roof skin only. Avoid color 7; use 71. Make the first plan complete and compact enough to compile; keep part count modest. Never describe the plan in prose."""


FAMILY_PARTS = [
    "3039",
    "3040b",
    "3298",
    "54200",
    "11477",
    "15068",
    "6081",
    "50950",
    "6141",
    "4073",
    "4032",
    "3941",
    "87081",
    "60623",
    "60594",
    "60603",
    "30044",
    "3185",
    "3823",
    "2412b",
    "3633",
    "30099",
    "6255",
    "3743",
    "4716",
    "3648",
    "32270",
    "3700",
    "3705",
    "6538c",
    "55423",
    "4624",
    "3062b",
    "4070",
    "2877",
    "3069b",
]
PALETTE = (0, 1, 2, 4, 7, 14, 15, 19, 22, 25, 28, 70, 71, 72, 78, 272, 288, 484)


def catalog_guide(catalog):
    lines = []
    for part in FAMILY_PARTS:
        colors = [
            c
            for c in PALETTE
            if (part, c) in catalog.parts and catalog.parts[part, c].max_quantity != 0
        ]
        if colors:
            name = catalog.parts[part, colors[0]].name
            lines.append(f"{part} {name}: {','.join(map(str, colors))}")
    return (
        "Available specialty parts and allowed colors (prefer these for curved and thin details):\n"
        + "\n".join(lines)
    )


def roof_rows(kind, col, x, z, y, span, depth):
    # A 3039 has two studs at z=0 and slopes toward -Z; its low row lies one stud forward.
    for course in range((depth - 2) // 2):
        for offset in range(0, span, 2):
            width = min(2, span - offset)
            part = "3039" if width == 2 else "3040b"
            for cross, turn in [(1 + course, 0), (depth - 2 - course, 2)]:
                along = offset + (width - 1) / 2
                if kind == "roofX":
                    yield part, col, x + along, z + cross, y + 3 * (course + 1), turn
                else:
                    yield (
                        part,
                        col,
                        x + cross,
                        z + along,
                        y + 3 * (course + 1),
                        (turn + 1) % 4,
                    )


def integer(x, lo, hi):
    if type(x) is not int or not lo <= x <= hi:
        raise ValueError(f"Expected integer in {lo}..{hi}")
    return x


def placement(part, color, x, z, top, turn):
    return (
        f"1 {color} {x * 20:g} {-top * 8:g} {z * 20:g} {ROTATIONS[turn % 4]} {part}.dat"
    )


def inside(kind, i, j, k, w, d, h):
    u, v, t = (2 * i + 1) / w - 1, (2 * j + 1) / d - 1, (k + 0.5) / h
    if kind == "shell":
        return i in (0, w - 1) or j in (0, d - 1)
    if kind == "ellipsoid":
        return u * u + v * v + (2 * t - 1) ** 2 <= 1
    if kind in ("cylinder", "circlecut"):
        return u * u + v * v <= 1
    if kind == "cone":
        return u * u + v * v <= max((1 - t) ** 2, 1 / min(w, d) ** 2)
    if kind.startswith("gable"):
        return t <= 1 - abs(v if kind == "gableX" else u) + 0.5 / h
    return True


def compile_scene(plan, catalog, cap):
    if not isinstance(plan, list) or not 1 <= len(plan) <= 200:
        raise ValueError("Expected 1..200 operations")
    cells = {}
    rows = []
    counts = Counter()
    work = 0

    def available(part, col):
        item = catalog.parts.get((part, col))
        return item and (
            item.max_quantity is None or counts[part, col] < item.max_quantity
        )

    def emit(part, col, x, z, y, turn):
        if not available(part, col):
            raise ValueError(f"Unavailable part/color {part}/{col}")
        counts[part, col] += 1
        rows.append(placement(part, col, x, z, y, turn))
        if len(rows) > cap:
            raise ValueError(f"Exceeds {cap} pieces")

    for item in plan:
        if not isinstance(item, list) or not item:
            raise ValueError("Malformed operation")
        count = 1
        dx = dz = dy = 0
        if item[0] == "repeat":
            _, count, dx, dz, dy, item = item
            integer(count, 1, 64)
            for q in (dx, dz, dy):
                integer(q, -64, 64)
        for n in range(count):
            kind, col, x, z, y, *params = item
            integer(col, 0, 511)
            for coord in (x, z, y):
                if type(coord) not in (int, float) or not -128 <= coord <= 128:
                    raise ValueError("Invalid position")
            x += n * dx
            z += n * dz
            y += n * dy
            if col in (7, 8) and not available("3024", col):
                col = {7: 71, 8: 72}[col]
            if kind in ("roofX", "roofZ"):
                span, depth = [integer(q, 4, 64) for q in params]
                if depth % 2:
                    raise ValueError("Roof cross span must be even")
                for placement_args in roof_rows(kind, col, x, z, y, span, depth):
                    emit(*placement_args)
                continue
            if kind == "part":
                part, turn = params
                emit(str(part).removesuffix(".dat"), col, x, z, y, integer(turn, -3, 3))
                continue
            if kind not in SHAPES or any(type(a) is not int for a in (x, z, y)):
                raise ValueError("Invalid shape or grid coordinate")
            w, d, h = [integer(a, 1, 64) for a in params]
            work += w * d * h
            if work > 1600000:
                raise ValueError("Scene too large")
            for k in range(h):
                for j in range(d):
                    for i in range(w):
                        if inside(kind, i, j, k, w, d, h):
                            key = (x + i, z + j, y + k)
                            if kind in ("cut", "circlecut"):
                                cells.pop(key, None)
                            else:
                                cells[key] = col

    def direction(y):
        return -1 if (y // 3) % 2 else 1

    for x, z, y in sorted(
        cells, key=lambda t: (t[2], direction(t[2]) * t[1], direction(t[2]) * t[0])
    ):
        if (x, z, y) not in cells:
            continue
        col = cells[x, z, y]
        found = False
        for height, opts in [(3, BRICKS), (1, PLATES)]:
            for w, d, part in opts:
                if not available(part, col):
                    continue
                for turn in (0, 1) if (y // 3) % 2 == 0 else (1, 0):
                    sx, sz = (d, w) if turn else (w, d)
                    footprint = [
                        (x + direction(y) * i, z + direction(y) * j, y + k)
                        for k in range(height)
                        for j in range(sz)
                        for i in range(sx)
                    ]
                    if all(cells.get(pos) == col for pos in footprint):
                        emit(
                            part,
                            col,
                            x + direction(y) * (sx - 1) / 2,
                            z + direction(y) * (sz - 1) / 2,
                            y + height,
                            turn,
                        )
                        for pos in footprint:
                            del cells[pos]
                        found = True
                        break
                if found:
                    break
            if found:
                break
        if not found:
            raise ValueError(
                f"No allowed rectangular element for color {col} at {(x, z, y)}"
            )
    if not rows:
        raise ValueError("Empty model")
    return rows
