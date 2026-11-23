# Lake house: gambrel-roofed main house with balcony and wraparound porch, attached garage.
SIDING, TRIM, ROOF, GLASS = "Sand_Blue", "White", "Dark_Bluish_Grey", "Trans_Clear"
LAWN, DRIVE, STONE = "Green", "Light_Bluish_Grey", "Light_Bluish_Grey"
TRUNK, LEAF, SHRUB = "Reddish_Brown", "Dark_Green", "Bright_Green"

BW, BD = 48, 38                    # base, studs
HX, HZ, HW, HD = 24, 12, 16, 20    # main house min corner, width (x), depth (z)
GX, GZ, GW, GD = 4, 20, 20, 12     # garage min corner, width, depth
PORCH_Z, PORCH_X1, SIDE_Z1 = 7, 46, 25   # porch front row, right edge (exclusive), side porch end (exclusive)
BAL_X0, BAL_X1 = HX + 3, HX + 13         # balcony span (exclusive end); its corner posts stand on the porch

G = 2                # top of the two-layer base: everything on the ground starts here
FLOOR = G + 3        # top of the foundation: the ground-floor slab sits here
WALL = FLOOR + 1     # ground-floor walls start
STOREY = 18          # six brick courses
SLAB2 = WALL + STOREY          # upper floor / balcony slab
R = SLAB2 + 1                  # roof and upper gable start

house = rect(HX, HZ, HX + HW, HZ + HD)
porch = rect(HX - 2, PORCH_Z, PORCH_X1, HZ) | rect(HX + HW, HZ, PORCH_X1, SIDE_Z1)


def glazed(frame, pane, x, y, z, rot=0):
    host = place(frame, TRIM, x, y, z, rot=rot)
    inset(pane, GLASS, host)
    return host


def walls(cells, y0, courses, color, openings=()):
    """Brick courses over `cells`, leaving each (cells, y_from, y_to) opening clear."""
    for c in range(courses):
        y = y0 + 3 * c
        clear = set()
        for hole, lo, hi in openings:
            if lo < y + 3 and hi > y:
                clear |= hole
        fill(cells - clear, y, color)


# ---------------------------------------------------------------- ground
module("ground")
drive = rect(GX + 2, 0, GX + 15, GZ)
fill(rect(0, 0, BW, BD), 0, LAWN, kind="plate", layers=2)   # two bonded layers make one rigid base
fill(drive, G, DRIVE, kind="tile")

# ---------------------------------------------------------------- house shell
module("foundation")
fill(ring(HX, HZ, HX + HW, HZ + HD), G, STONE)

module("porch")
front_posts = [HX - 2, BAL_X0, BAL_X1 - 1, PORCH_X1 - 1]
for x in front_posts:
    place("3005", TRIM, x, G, PORCH_Z)
for x in (HX - 1, BAL_X0 + 1, BAL_X0 + 5, BAL_X1, BAL_X1 + 4):          # lattice skirt, front
    place("3633", TRIM, x, G, PORCH_Z, facing="back")
for z in range(PORCH_Z + 1, SIDE_Z1 - 1, 4):                             # lattice skirt, right side
    place("3633", TRIM, PORCH_X1 - 1, G, z, facing="left")
place("3005", TRIM, PORCH_X1 - 1, G, SIDE_Z1 - 1)
place("3633", TRIM, PORCH_X1 - 5, G, SIDE_Z1 - 1, facing="front")
place("3005", TRIM, HX + HW, G, SIDE_Z1 - 1)
place("3622", TRIM, HX - 2, G, PORCH_Z + 1, rot=90)                      # riser behind the steps
fill(rect(HX - 2, HZ - 1, HX, HZ), G, TRIM)

module("floor")
fill(house | porch, FLOOR, TRIM, kind="plate")

module("steps")
SX = HX - 5
place("3622", TRIM, SX + 2, G, PORCH_Z + 1, rot=90)
for level in range(2):
    place("3623", TRIM, SX + 1, G + level, PORCH_Z + 1, rot=90)
place("3623", TRIM, SX, G, PORCH_Z + 1, rot=90)

module("railing")
for x in (HX - 2, PORCH_X1 - 1):
    fill([(x, PORCH_Z)], WALL, TRIM, layers=2)
for x in (BAL_X0, BAL_X1 - 1):                                           # columns carrying the balcony
    place("2453b", TRIM, x, WALL, PORCH_Z)
    place("3005", TRIM, x, WALL + 15, PORCH_Z)
for x in (HX - 1, BAL_X0 + 1, BAL_X0 + 5, BAL_X1, BAL_X1 + 4):
    place("15332", TRIM, x, WALL, PORCH_Z)
for z in range(PORCH_Z + 1, SIDE_Z1 - 1, 4):
    place("15332", TRIM, PORCH_X1 - 1, WALL, z, rot=90)
fill([(PORCH_X1 - 1, SIDE_Z1 - 1), (HX + HW, SIDE_Z1 - 1)], WALL, TRIM, layers=2)
place("15332", TRIM, PORCH_X1 - 5, WALL, SIDE_Z1 - 1)
fill(rect(HX - 2, HZ - 1, HX, HZ), WALL, TRIM, layers=2)

module("walls")
front_windows = [HX + 1, HX + 6, HX + 11]
left_windows = [HZ + 2, HZ + 5]
right_windows = [HZ + 3, HZ + 9]
back_windows = [HX + 4, HX + 10]
openings = [(rect(x, HZ, x + 4, HZ + 1), WALL, WALL + 18) for x in front_windows]
openings += [(rect(HX, z, HX + 1, z + 2), WALL + 6, WALL + 12) for z in left_windows]
openings += [(rect(HX + HW - 1, z, HX + HW, z + 4), WALL + 6, WALL + 15) for z in right_windows]
openings += [(rect(x, HZ + HD - 1, x + 2, HZ + HD), WALL + 6, WALL + 12) for x in back_windows]
walls(ring(HX, HZ, HX + HW, HZ + HD), WALL, 6, SIDING, openings)
for x in front_windows:
    glazed("57894", "57895", x, WALL, HZ)
for z in left_windows:
    glazed("60592", "60601", HX, WALL + 6, z, rot=90)
for z in right_windows:
    glazed("60594", "60603", HX + HW - 1, WALL + 6, z, rot=270)
for x in back_windows:
    glazed("60592", "60601", x, WALL + 6, HZ + HD - 1, rot=180)

module("upper floor")
# A two-stud ring is enough to carry the roof; a full floor would leave loose plates in the middle.
fill(ring(HX - 1, HZ - 1, HX + HW + 1, HZ + HD + 1, 2) | rect(BAL_X0, PORCH_Z, BAL_X1, HZ), SLAB2, TRIM, kind="plate")

module("balcony")
for x in (BAL_X0, BAL_X1 - 1):
    fill([(x, PORCH_Z)], R, TRIM, layers=2)
    place("15332", TRIM, x, R, PORCH_Z + 1, rot=90)
for x in (BAL_X0 + 1, BAL_X0 + 5):
    place("15332", TRIM, x, R, PORCH_Z)

# ---------------------------------------------------------------- gambrel roof
# Half profile from the eave inward: (course height, cells covered counted from i, piece, piece depth)
STEEP, SHALLOW = 6, 3


def gable_wall(z, openings=()):
    spans = [(R, 2, 1, 14), (R + 6, 2, 2, 13), (R + 12, 2, 3, 12), (R + 18, 1, 5, 10), (R + 21, 1, 7, 8)]
    for y0, courses, i0, i1 in spans:
        walls(rect(HX + i0, z, HX + i1 + 1, z + 1), y0, courses, SIDING, openings)


module("gable front")
balcony_doors = [HX + 4, HX + 8]
peak_windows = [HX + 6, HX + 8]
front_gable_openings = [(rect(x, HZ, x + 4, HZ + 1), R, R + 9) for x in balcony_doors]
front_gable_openings += [(rect(x, HZ, x + 2, HZ + 1), R + 12, R + 18) for x in peak_windows]
gable_wall(HZ, front_gable_openings)
for x in balcony_doors:
    glazed("60594", "60603", x, R, HZ)
for x in peak_windows:
    glazed("60592", "60601", x, R + 12, HZ)

module("gable back")
back_gable_openings = [(rect(HX + 7, HZ + HD - 1, HX + 9, HZ + HD), R + 3, R + 9)]
gable_wall(HZ + HD - 1, back_gable_openings)
glazed("60592", "60601", HX + 7, R + 3, HZ + HD - 1, rot=180)

module("roof")
Z0, Z1 = HZ - 1, HZ + HD + 1            # one white row at each end as the bargeboard
DORMER_Z = [HZ + 4, HZ + 6]


def roof_side(side):
    left = side == "left"
    steep_x = [HX - 1, HX, HX + 1] if left else [HX + HW - 1, HX + HW - 2, HX + HW - 3]
    shallow_x = [HX + 2, HX + 4] if left else [HX + HW - 5, HX + HW - 7]
    for z, wide in [(Z0, False)] + [(z, True) for z in range(HZ, HZ + HD, 2)] + [(Z1 - 1, False)]:
        color = ROOF if wide else TRIM
        for course, x in enumerate(steep_x):
            if left and wide and z in DORMER_Z and course in (1, 2):
                continue                                   # the dormer replaces these pieces
            place("3678b" if wide else "60481a", color, x, R + STEEP * course, z, facing=side)
        for course, x in enumerate(shallow_x):
            place("3298" if wide else "4286", color, x, R + 3 * STEEP + SHALLOW * course, z, facing=side)


roof_side("left")
roof_side("right")
RIDGE = R + 3 * STEEP + 2 * SHALLOW
place("3710", TRIM, HX + 6, RIDGE, Z0)
place("3710", TRIM, HX + 6, RIDGE, Z1 - 1)
for z in range(HZ, HZ + HD, 2):
    place("3020", ROOF, HX + 6, RIDGE, z)
    place("3300", ROOF, HX + 7, RIDGE + 1, z, rot=90)
for z in (Z0, Z1 - 1):
    place("3044c", TRIM, HX + 7, RIDGE + 1, z, rot=90)
fill(rect(HX + 6, Z0, HX + 7, Z1) | rect(HX + 9, Z0, HX + 10, Z1), RIDGE + 1, ROOF, kind="tile")

module("dormer")
for z in DORMER_Z:
    glazed("60592", "60601", HX, R + STEEP, z, rot=90)
    place("3298", ROOF, HX, R + 2 * STEEP, z, facing="left")
place("3010", SIDING, HX + 2, R + 2 * STEEP + 3, DORMER_Z[0], rot=90)

# ---------------------------------------------------------------- garage
module("garage")
GTOP = G + 12
DOOR_X0, DOOR_X1 = GX + 3, GX + 15
garage_cells = (rect(GX, GZ, GX + GW, GZ + 1) | rect(GX, GZ, GX + 1, GZ + GD)
                | rect(GX, GZ + GD - 1, GX + GW, GZ + GD))
door = rect(DOOR_X0, GZ, DOOR_X1, GZ + 1)
walls(garage_cells - door, G, 3, SIDING)
lintel = rect(DOOR_X0 - 1, GZ, DOOR_X1 + 1, GZ + 1)
fill(lintel, G + 9, TRIM)
fill(garage_cells - lintel, G + 9, SIDING)
for course in range(3):                                    # sectional door from fluted bricks, bonded
    y = G + 3 * course
    if course % 2:
        place("3005", TRIM, DOOR_X0, y, GZ)
        row("2877", TRIM, DOOR_X0 + 1, y, GZ, 5)
        place("3005", TRIM, DOOR_X1 - 1, y, GZ)
    else:
        row("2877", TRIM, DOOR_X0, y, GZ, 6)

module("garage roof")
for x in range(GX - 1, GX + GW - 1, 2):
    place("3298", ROOF, x, GTOP, GZ - 1, facing="front")
    place("3298", ROOF, x, GTOP + 3, GZ + 1, facing="front")
    place("3298", ROOF, x, GTOP, GZ + GD - 2, facing="back")
    place("3298", ROOF, x, GTOP + 3, GZ + GD - 4, facing="back")
    place("3795", ROOF, x, GTOP + 6, GZ + 3, rot=90)
    place("3300", ROOF, x, GTOP + 7, GZ + 5)
x = GX + GW - 1                                            # last single-stud strip against the house
place("4286", ROOF, x, GTOP, GZ - 1, facing="front")
place("4286", ROOF, x, GTOP + 3, GZ + 1, facing="front")
place("4286", ROOF, x, GTOP, GZ + GD - 2, facing="back")
place("4286", ROOF, x, GTOP + 3, GZ + GD - 4, facing="back")
place("3666", ROOF, x, GTOP + 6, GZ + 3, rot=90)
place("3069b", ROOF, x, GTOP + 7, GZ + 5, rot=90)
fill(rect(GX - 1, GZ + 4, GX + GW, GZ + 5) | rect(GX - 1, GZ + 7, GX + GW, GZ + 8), GTOP + 7, ROOF, kind="tile")
# gable end of the garage
fill(rect(GX, GZ + 2, GX + 1, GZ + GD - 2), GTOP, SIDING)
fill(rect(GX, GZ + 4, GX + 1, GZ + GD - 4), GTOP + 3, SIDING)

# ---------------------------------------------------------------- landscape
module("trees")


def tree(x, z, trunk_bricks, canopy):
    for level in range(trunk_bricks):
        place("3941", TRUNK, x, G + 3 * level, z)
    y = G + 3 * trunk_bricks
    for size in canopy:
        half = size // 2 - 1
        fill(rect(x - half, z - half, x + 2 + half, z + 2 + half), y, LEAF)
        y += 3


tree(43, 31, 12, [4, 6, 8, 8, 6, 4])     # tall tree behind the house on the right
tree(9, 34, 8, [4, 6, 6, 4])             # smaller one behind the garage

module("shrubs")
for x, z in [(21, 14), (21, 17), (46, 10), (46, 19), (1, 22)]:
    place("3941", SHRUB, x, G, z)
    place("30367c", SHRUB, x, G + 3, z)
