# ---------------- Lake house: gambrel chalet + garage ----------------
BW, BD = 48, 32
GX0 = 5                 # garage left
HX0, HX1 = 19, 35       # house x range
HZ0, HZ1 = 15, 31       # house z range
GZ0, GZ1 = 23, 31       # garage z range
PZ0 = 10                # porch front edge
PX1 = HX1 + 5           # porch right edge
PZ1 = HZ0 + 8           # side porch back edge
G = 2                   # ground top
D = 7                   # deck / first floor level
W1 = 22                 # first floor wall top
E = 23                  # eave level (top of trim plate)
R0, R1 = HX0 - 1, HX1 + 1
ZR0, ZR1 = HZ0 - 3, HZ1 + 1

WALL = "Sand_Blue"
TRIM = "White"
ROOF = "Dark_Bluish_Grey"
LAWN = "Bright_Green"
DRIVE = "Dark_Bluish_Grey"
GLASS = "Trans_Brown"
DOORF = "Reddish_Brown"

def rz(pid):
    p = part(pid)
    return 90 if p.w > p.d else 0

def rx(pid):
    p = part(pid)
    return 0 if p.w >= p.d else 90

def walls(cells, y0, y1, color, openings):
    # group consecutive layers that share the same cell set
    y = y0
    prev = None
    start = y0
    n = 0
    while y < y1:
        c = set(cells)
        for (oc, a, b) in openings:
            if a <= y < b:
                c = c - oc
        key = frozenset(c)
        if prev is None:
            prev = key; start = y; n = 1
        elif key == prev:
            n += 1
        else:
            fill(set(prev), start, color, layers=n)
            prev = key; start = y; n = 1
        y += 3
    if prev is not None:
        fill(set(prev), start, color, layers=n)

def window(pid, glass, color, x, y, z, rot=0):
    w = place(pid, color, x, y, z, rot=rot)
    inset(glass, GLASS, w)
    return w

# ---------------- ground ----------------
def ground():
    module("ground")
    fill(rect(0, 0, BW, BD), 0, LAWN, kind="plate", layers=2)
    drive = rect(GX0 + 2, HZ0, GX0 + 12, GZ0) | rect(GX0 + 3, 8, GX0 + 13, HZ0) | rect(GX0 + 4, 0, GX0 + 14, 8)
    fill(drive, G, DRIVE, kind="tile")

# ---------------- house ----------------
def house():
    module("house walls")
    r = ring(HX0, HZ0, HX1, HZ1)
    fill(r, G, "Light_Bluish_Grey")
    fill(r, G + 3, WALL, kind="plate", layers=2)
    fx = [HX0 + 1, HX0 + 6, HX0 + 11]
    ops = []
    for x in fx:
        ops.append((rect(x, HZ0, x + 4, HZ0 + 1), D, W1))
    pillars = {(HX0 + 5, HZ0), (HX0 + 10, HZ0)}
    ops.append((pillars, D, W1))
    ops.append((rect(HX1 - 1, HZ0 + 2, HX1, HZ0 + 6), D, W1))          # right tall door
    ops.append((rect(HX1 - 1, HZ0 + 10, HX1, HZ0 + 14), D + 3, D + 12))  # right window
    ops.append((rect(HX0, HZ0 + 2, HX0 + 1, HZ0 + 6), D + 3, D + 12))    # left window
    ops.append((rect(HX0 + 2, HZ1 - 1, HX0 + 6, HZ1), D + 3, D + 12))    # back windows
    ops.append((rect(HX0 + 10, HZ1 - 1, HX0 + 14, HZ1), D + 3, D + 12))
    walls(r, D, W1, WALL, ops)
    module("windows")
    for x in fx:
        window("2493b", "2494", DOORF, x, D, HZ0)
    window("2493b", "2494", TRIM, HX1 - 1, D, HZ0 + 2, rot=270)
    window("60594", "60603", TRIM, HX1 - 1, D + 3, HZ0 + 10, rot=270)
    window("60594", "60603", TRIM, HX0, D + 3, HZ0 + 2, rot=90)
    window("60594", "60603", TRIM, HX0 + 2, D + 3, HZ1 - 1, rot=180)
    window("60594", "60603", TRIM, HX0 + 10, D + 3, HZ1 - 1, rot=180)
    # white pillars with balcony brackets
    for (x, z) in sorted(pillars):
        place("14716", TRIM, x, D, z)
        place("3005", TRIM, x, D + 9, z)
        place("3665a", TRIM, x, D + 12, z - 1, facing="front")

    module("trim plates")
    # eave fascia plates, cantilevered 3 studs to the front
    for x in (R0, R1 - 2):
        place("4282", TRIM, x, W1, ZR0, rot=rz("4282"))
        place("3020", TRIM, x, W1, ZR0 + 16, rot=rz("3020"))
    # balcony floor
    place("3029", TRIM, HX0 + 2, W1, HZ0 - 3, rot=rx("3029"))
    place("3024", TRIM, HX0 + 1, W1, HZ0)
    place("3024", TRIM, HX1 - 2, W1, HZ0)
    fill(rect(HX0 + 1, HZ1 - 1, HX1 - 1, HZ1), W1, TRIM, kind="plate")

    module("front gable")
    z = HZ0
    for x in (HX0 + 1, HX1 - 2):
        place("3005", WALL, x, E, z)
        place("3005", WALL, x, E + 3, z)
    for x in (HX0 + 2, HX0 + 6, HX0 + 10):
        window("60594", "60603", TRIM, x, E, z)
    place("3009", TRIM, HX0 + 2, E + 9, z)
    place("3009", TRIM, HX0 + 8, E + 9, z)
    place("3622", "Black", HX0 + 4, E + 12, z)
    place("3004", TRIM, HX0 + 7, E + 12, z)
    place("3622", "Black", HX0 + 9, E + 12, z)
    place("3005", "Black", HX0 + 6, E + 15, z)
    place("3004", TRIM, HX0 + 7, E + 15, z)
    place("3005", "Black", HX0 + 9, E + 15, z)
    # balcony railing
    for x in (HX0 + 2, HX0 + 6, HX0 + 10):
        place("15332", TRIM, x, E, HZ0 - 3)

    module("back gable")
    z = HZ1 - 1
    win = rect(HX0 + 6, z, HX0 + 10, z + 1)
    fill(rect(HX0 + 1, z, HX1 - 1, z + 1) - win, E, WALL, layers=2)
    fill(rect(HX0 + 2, z, HX1 - 2, z + 1) - win, E + 6, WALL)
    fill(rect(HX0 + 2, z, HX1 - 2, z + 1), E + 9, WALL)
    fill(rect(HX0 + 4, z, HX1 - 4, z + 1), E + 12, WALL)
    fill(rect(HX0 + 6, z, HX1 - 6, z + 1), E + 15, WALL)
    window("60594", "60603", TRIM, HX0 + 6, E, z, rot=180)

def zrun(z0, z1, skip, odd):
    out = []
    z = z0
    first = True
    while z < z1:
        if z in skip:
            z += 1
            continue
        n = 2
        if (first and odd) or z + 1 >= z1 or (z + 1) in skip:
            n = 1
        out.append((z, n))
        z += n
        first = False
    return out

def house_roof():
    module("house roof")
    dz0 = HZ0 + 2
    dskip = set(range(dz0, dz0 + 4))
    courses = [
        (E, 0, 2, "3678b", "60481a", True),
        (E + 6, 1, 2, "3678b", "60481a", True),
        (E + 12, 2, 3, "3298", "4286", False),
        (E + 15, 4, 3, "3298", "4286", False),
        (E + 18, 6, 3, "3298", "4286", False),
    ]
    i = 0
    for (y, off, w, p2, p1, steep) in courses:
        for side in ("left", "right"):
            x = R0 + off if side == "left" else R1 - off - w
            skip = dskip if (side == "left" and steep) else set()
            place(p1, TRIM, x, y, ZR0, facing=side)      # white barge board slice
            for (z, n) in zrun(ZR0 + 1, ZR1, skip, i % 2 == 1):
                place(p2 if n == 2 else p1, ROOF, x, y, z, facing=side)
        i += 1
    # ridge
    for k in range(5):
        place("3299", ROOF, R0 + 8, E + 21, ZR0 + 4 * k, rot=rz("3299"))
    # dormer on the left roof
    module("dormer")
    window("60594", "60603", TRIM, HX0, E, dz0, rot=90)
    for z in (dz0, dz0 + 2):
        place("3298", ROOF, R0, E + 9, z, facing="left")
        place("85984", ROOF, R0, E, z, facing="left")

# ---------------- garage ----------------
def garage():
    module("garage")
    cells = rect(GX0, GZ0, HX0, GZ0 + 1) | rect(GX0, GZ0, GX0 + 1, GZ1) | rect(GX0, GZ1 - 1, HX0, GZ1)
    door = rect(GX0 + 2, GZ0, GX0 + 12, GZ0 + 1)
    lint = rect(GX0 + 1, GZ0, GX0 + 13, GZ0 + 1)
    walls(cells, G, G + 15, WALL, [(door, G, G + 12), (lint, G + 12, G + 15)])
    for k in range(4):
        row("2877", TRIM, GX0 + 2, G + 3 * k, GZ0, 5)
    place("6112", TRIM, GX0 + 1, G + 12, GZ0, rot=rx("6112"))
    gy = G + 15
    place("3010", WALL, GX0, gy, GZ0 + 2, rot=rz("3010"))
    module("garage roof")
    x0 = GX0 - 1
    for (z, f) in ((GZ0 - 1, "front"), (GZ1 - 2, "back")):
        for k in range(7):
            place("3298", ROOF, x0 + 2 * k, gy, z, facing=f)
        place("4286", ROOF, x0 + 14, gy, z, facing=f)
    for (z, f) in ((GZ0 + 1, "front"), (GZ0 + 4, "back")):
        place("4286", ROOF, x0, gy + 3, z, facing=f)
        for k in range(6):
            place("3298", ROOF, x0 + 1 + 2 * k, gy + 3, z, facing=f)
        place("4286", ROOF, x0 + 13, gy + 3, z, facing=f)
    for k in range(3):
        place("3299", ROOF, x0 + 4 * k, gy + 6, GZ0 + 3, rot=rx("3299"))
    place("3300", ROOF, x0 + 12, gy + 6, GZ0 + 3)
    # plug under the house eave
    place("3666", ROOF, HX0 - 1, gy + 3, GZ0 + 1, rot=rz("3666"))
    place("3666", ROOF, HX0 - 1, gy + 4, GZ0 + 1, rot=rz("3666"))

# ---------------- porch ----------------
def porch():
    module("porch")
    deck = rect(HX0, PZ0, PX1, HZ0) | rect(HX1, HZ0, PX1, PZ1)
    sup = (rect(HX0 + 1, PZ0 + 1, PX1 - 1, PZ0 + 2) | rect(HX0 + 1, HZ0 - 1, HX1 + 1, HZ0)
           | rect(PX1 - 2, PZ0 + 2, PX1 - 1, PZ1 - 1) | rect(HX1, HZ0, HX1 + 1, PZ1 - 1)
           | rect(HX1 + 1, PZ1 - 2, PX1 - 2, PZ1 - 1) | rect(HX0 + 1, PZ0 + 2, HX0 + 2, HZ0 - 1))
    fill(sup, G, "Dark_Bluish_Grey")
    place("3005", TRIM, HX0, G, PZ0)
    for k in range(5):
        place("3633", TRIM, HX0 + 1 + 4 * k, G, PZ0)
    for k in range(3):
        place("3633", TRIM, PX1 - 1, G, PZ0 + 1 + 4 * k, facing="left")
    place("3633", TRIM, HX1, G, PZ1 - 1, facing="front")
    place("3633", TRIM, HX0, G, PZ0 + 1, facing="right")
    fill(deck, G + 3, TRIM, kind="plate", layers=2)
    # railings
    place("3005", TRIM, HX0, D, PZ0)
    place("3005", TRIM, HX0, D + 3, PZ0)
    for k in range(4):
        place("15332", TRIM, HX0 + 5 + 4 * k, D, PZ0)
    for k in range(3):
        place("15332", TRIM, PX1 - 1, D, PZ0 + 1 + 4 * k, rot=90)
    place("15332", TRIM, HX1, D, PZ1 - 1)
    place("15332", TRIM, HX0, D, PZ0 + 1, rot=90)
    # steps
    sx = HX0 + 1
    place("3710", TRIM, sx, G, PZ0 - 2)
    place("3710", TRIM, sx, G + 1, PZ0 - 2)
    place("3010", TRIM, sx, G, PZ0 - 1)
    place("3710", TRIM, sx, G + 3, PZ0 - 1)

# ---------------- trees ----------------
def tree(x, z, h, radii):
    module("tree")
    for i in range(h):
        place("3941", "Dark_Brown", x, G + 3 * i, z)
    y = G + 3 * h
    cx, cz = x + 1, z + 1
    strips = {2: "3004", 4: "3010", 6: "3009", 8: "3008"}
    k = 0
    for r in radii:
        for a in range(-5, 5):
            hw = 0
            for b in range(1, 6):
                if (a + 0.5) ** 2 + (b - 0.5) ** 2 <= r * r:
                    hw = b
            if hw == 0:
                continue
            pid = strips[2 * hw]
            if k % 2 == 0:
                place(pid, "Green", cx - hw, y, cz + a, rot=rx(pid))
            else:
                place(pid, "Green", cx + a, y, cz - hw, rot=rz(pid))
        y += 3
        k += 1

ground()
house()
house_roof()
garage()
porch()
tree(40, 3, 15, [2.6, 3.6, 4.0, 4.0, 3.6, 2.6])
tree(41, 25, 17, [2.6, 3.6, 4.0, 4.0, 3.6, 2.6])
tree(2, 12, 9, [2.6, 3.0, 2.6])

def extras():
    module("details")
    # lamp post by the steps
    lx, lz = HX0 - 1, PZ0 - 1
    for i in range(3):
        place("3062b", "Black", lx, G + 3 * i, lz)
    place("3062b", "Trans_Yellow", lx, G + 9, lz)
    place("4073", "Black", lx, G + 12, lz)
    # bins between garage and house
    for z in (GZ0 - 2, GZ0 - 3):
        place("3005", "Black", HX0 - 1, G, z)
        place("3070b", "Black", HX0 - 1, G + 3, z)

extras()
