#: title: Lake house
#: source: written for BrickBuilder
# Lake house, 20 x 14 studs:
# a stone base 2 bricks tall, walls 7 bricks tall, a gable roof, a deck on the lake side and a dock.
WATER, GRASS, STONE = "Blue", "Green", "Dark_Bluish_Grey"
SIDING, TRIM, ROOF = "Sand_Blue", "White", "Dark_Bluish_Grey"

module("lake and shore")
fill(rect(0, 0, 36, 36), 0, WATER, "plate", layers=2)   # the lake is the base: one piece under everything
G = 4                                                   # the shore is 2 plates higher than the water
fill(rect(0, 0, 36, 26), 2, GRASS, "plate", layers=2)

module("stone base")
fill(ring(8, 4, 28, 18), G, STONE, layers=2)           # 6 plates of hollow base
fill(rect(8, 4, 28, 18), G + 6, "Tan", "plate")         # one floor over all of it: the walls stand on its edge
F = G + 7

step()
module("walls")
# Front and back walls cover the corners; the side walls fit between them.
wall(8, F, 4, 20, 21, style="siding", color=SIDING, trim=TRIM,
     openings=[(2, 6, 4, 9), (8, 0, 4, 18), (14, 6, 4, 9)])
window(10, F + 6, 4, style="wide", color=TRIM)
door(16, F, 4, style="panel", color=TRIM, leaf="Dark_Red")
window(22, F + 6, 4, style="wide", color=TRIM)
wall(8, F, 17, 20, 21, style="siding", color=SIDING, trim=TRIM, facing="back",
     openings=[(2, 3, 4, 15), (8, 0, 4, 18), (14, 3, 4, 15)])
window(10, F + 3, 17, style="picture", color=TRIM, facing="back")      # big windows face the lake
door(16, F, 17, style="glazed", color=TRIM, facing="back")
window(22, F + 3, 17, style="picture", color=TRIM, facing="back")
for x, facing in ((8, "left"), (27, "right")):
    wall(x, F, 5, 12, 21, style="siding", color=SIDING, trim=TRIM, facing=facing, openings=[(4, 6, 4, 9)])
    window(x, F + 6, 9, style="wide", color=TRIM, facing=facing)

step()
module("roof")
roof(8, F + 21, 4, 20, 14, style="gable", color=ROOF, trim=TRIM, facing="front", gable=SIDING)
chimney(6, G, 12, height=42, style="stone", color=STONE)   # up the outside of the left wall

module("front steps")
stairs(16, G, 1, width=4, rise=7, style="steep", color=STONE, facing="front")   # 4 x 3 in front of the door

step()
module("deck and dock")
deck(10, G, 18, 16, 6, height=7, style="deck", color="Reddish_Brown", railing=("back", "left", "right"), steps=None)
deck(16, 2, 26, 4, 10, height=4, style="dock", color="Reddish_Brown", railing=(), steps=None)

module("trees")
tree(2, G, 6, height=33, width=6, style="pine")
tree(31, G, 10, height=27, width=6, style="birch")
plant(4, G, 18, style="shrub")
