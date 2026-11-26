#: title: Log cabin
#: source: written for BrickBuilder
# Log cabin, 16 x 12 studs: log walls 6 bricks
# tall, a steep roof, a stone chimney up one side, and a covered porch across the front.
GRASS, LOGS, ROOF, STONE, TRIM = "Dark_Green", "Reddish_Brown", "Dark_Brown", "Dark_Bluish_Grey", "Dark_Tan"

module("ground")
fill(rect(0, 0, 32, 32), 0, GRASS, "plate", layers=2)
G = 2

module("floor")
fill(rect(8, 10, 24, 22), G, STONE, "plate")            # a floor under the whole cabin
F = G + 1

step()
module("log walls")
# Front and back walls cover the corners; the side walls fit between them.
wall(8, F, 10, 16, 18, style="log", color=LOGS, openings=[(2, 3, 4, 6), (6, 0, 4, 15), (11, 3, 4, 6)])
window(10, F + 3, 10, style="shuttered", color=TRIM, trim="Dark_Green")
door(14, F, 10, style="cabin", color=TRIM, leaf="Dark_Brown")
window(19, F + 3, 10, style="shuttered", color=TRIM, trim="Dark_Green")
wall(8, F, 21, 16, 18, style="log", color=LOGS, facing="back", openings=[(6, 3, 4, 6)])
window(14, F + 3, 21, style="double", color=TRIM, facing="back")
wall(8, F, 11, 10, 18, style="log", color=LOGS, facing="left")      # the chimney side has no window
wall(23, F, 11, 10, 18, style="log", color=LOGS, facing="right", openings=[(3, 3, 4, 6)])
window(23, F + 3, 14, style="double", color=TRIM, facing="right")

step()
module("roof and chimney")
roof(8, F + 18, 10, 16, 12, style="steep_gable", color=ROOF, facing="front", gable=LOGS)
chimney(6, G, 14, height=42, style="stone", color=STONE)            # up the outside of the left wall

step()
module("porch")
deck(8, G, 6, 16, 4, height=1, style="porch", color=LOGS, railing=(), steps=None)  # floor level with the door
for x in (8, 23):
    column(x, F, 6, height=18, style="square", color=LOGS)          # posts under the porch roof's front corners
fill(rect(8, 6, 24, 10), F + 18, ROOF, "plate", layers=2)          # a flat porch roof on the posts

module("woods")
for x, z, style in ((1, 2, "pine"), (27, 4, "spruce"), (2, 22, "fir"), (27, 22, "pine")):
    tree(x, G, z, height=36, width=6, style=style)
plant(18, G, 3, style="stump")
lamp(13, G, 3, style="campfire")
