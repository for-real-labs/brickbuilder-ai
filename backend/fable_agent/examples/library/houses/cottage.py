#: title: Cottage
#: source: written for BrickBuilder
# Cottage, 14 x 10 studs: walls 6 bricks tall,
# a gable roof, a small porch at the door, a picket fence and a flower garden.
GRASS, PATH, WALLS, TRIM, ROOF = "Green", "Tan", "Bright_Light_Yellow", "White", "Dark_Red"

module("garden")
fill(rect(0, 0, 30, 30), 0, GRASS, "plate", layers=2)
G = 2
fill(rect(14, 0, 16, 11), G, PATH, "tile")             # a path from the gate to the porch steps

module("floor")
fill(rect(8, 14, 22, 24), G, "Light_Bluish_Grey", "plate")
F = G + 1

step()
module("walls")
# Front and back walls cover the corners; the side walls fit between them.
wall(8, F, 14, 14, 18, style="base", color=WALLS, trim="Medium_Nougat",
     openings=[(1, 6, 4, 6), (5, 0, 4, 15), (10, 6, 3, 9)])
window(9, F + 6, 14, style="shuttered", color=TRIM, trim="Dark_Green")
door(13, F, 14, style="cabin", color=TRIM, leaf="Dark_Green")
window(18, F + 6, 14, style="square", color=TRIM)
wall(8, F, 23, 14, 18, style="base", color=WALLS, trim="Medium_Nougat", facing="back", openings=[(5, 6, 4, 6)])
window(13, F + 6, 23, style="double", color=TRIM, facing="back")
for x, facing in ((8, "left"), (21, "right")):
    wall(x, F, 15, 8, 18, style="base", color=WALLS, trim="Medium_Nougat", facing=facing, openings=[(2, 6, 4, 6)])
    window(x, F + 6, 17, style="double", color=TRIM, facing=facing)

step()
module("roof")
roof(8, F + 18, 14, 14, 10, style="gable", color=ROOF, facing="front", gable=WALLS)

step()
module("porch")
deck(12, G, 11, 6, 3, height=1, style="stoop", color="Light_Bluish_Grey", railing=(), steps=None)

module("fence and flowers")
for x0, length in ((1, 13), (16, 13)):
    railing(x0, G, 1, length, style="picket", color=TRIM)
for x in range(2, 12, 2):
    plant(x, G, 3, style=("tulip", "daisy", "rose")[x % 3], color=("Red", "Yellow", "Magenta")[x % 3])
tree(24, G, 4, height=27, width=6, style="apple")
plant(2, G, 18, style="berry_bush")
