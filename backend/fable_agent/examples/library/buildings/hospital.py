#: title: Town hospital
#: source: written for BrickBuilder
# Town hospital, 24 x 14 studs and two floors:
# floors 6 bricks tall, wide windows, a glazed entrance under a canopy and a red cross on the flat roof.
GROUND, ROAD, WALLS, TRIM, GLASS = "Light_Bluish_Grey", "Dark_Bluish_Grey", "White", "Red", "Trans_Light_Blue"

module("street and forecourt")
fill(rect(0, 0, 36, 32), 0, GROUND, "plate", layers=2)
G = 2
fill(rect(0, 0, 36, 4), G, ROAD, "tile")                # the street in front, as smooth tiles
F = G                                                   # the building stands right on the base

step()
module("ground floor")
# Front and back walls cover the corners; the side walls fit between them.
wall(6, F, 10, 24, 18, style="base", color=WALLS, trim="Light_Bluish_Grey",
     openings=[(2, 3, 4, 9), (8, 0, 8, 18), (18, 3, 4, 9)])
window(8, F + 3, 10, style="wide", color=WALLS, glass=GLASS)
door(14, F, 10, style="glazed_double", color=WALLS)
window(24, F + 3, 10, style="wide", color=WALLS, glass=GLASS)
wall(6, F, 23, 24, 18, style="plain", color=WALLS, facing="back", openings=[(10, 3, 4, 9)])
window(16, F + 3, 23, style="wide", color=WALLS, glass=GLASS, facing="back")
for x, facing in ((6, "left"), (29, "right")):
    wall(x, F, 11, 12, 18, style="plain", color=WALLS, facing=facing, openings=[(4, 3, 4, 9)])
    window(x, F + 3, 15, style="wide", color=WALLS, glass=GLASS, facing=facing)

module("upper floor")
U = F + 18
fill(rect(6, 10, 30, 24), U, WALLS, "plate", layers=2)  # a floor across the walls ties them together
U += 2
wall(6, U, 10, 24, 18, style="banded", color=WALLS, trim=TRIM,
     openings=[(2, 3, 4, 9), (8, 3, 8, 6), (18, 3, 4, 9)])
for x in (8, 24):
    window(x, U + 3, 10, style="wide", color=WALLS, glass=GLASS)
for x in (14, 18):
    window(x, U + 3, 10, style="double", color=WALLS, glass=GLASS)
wall(6, U, 23, 24, 18, style="plain", color=WALLS, facing="back")
for x, facing in ((6, "left"), (29, "right")):
    wall(x, U, 11, 12, 18, style="plain", color=WALLS, facing=facing)

step()
module("flat roof")
roof(6, U + 18, 10, 24, 14, style="flat", color=ROAD, trim=WALLS)
place("3068b", "Red", 17, U + 19, 16)                   # a red cross of 2x2 tiles on the roof (its top is U + 19)
place("3068b", "Red", 15, U + 19, 16)
place("3068b", "Red", 19, U + 19, 16)
place("3068b", "Red", 17, U + 19, 14)
place("3068b", "Red", 17, U + 19, 18)

module("entrance canopy and grounds")
for x in (12, 23):
    column(x, G, 6, height=18, style="square", color=WALLS)
fill(rect(12, 6, 24, 10), G + 18, WALLS, "plate", layers=2)     # canopy from the posts to the wall
tree(1, G, 26, height=27, width=6, style="round")
tree(31, G, 26, height=27, width=6, style="round")
lamp(2, G, 6, style="street")
