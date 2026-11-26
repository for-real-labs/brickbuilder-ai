#: title: Castle
#: source: written for BrickBuilder
# Castle, 32 x 32 studs: curtain walls 8 bricks tall
# with battlements, a 6 x 6 tower 11 bricks tall at each corner, an arched gate and a keep.
GRASS, STONE, DARK, WOOD, ROOF = "Green", "Light_Bluish_Grey", "Dark_Bluish_Grey", "Reddish_Brown", "Dark_Red"

module("ground")
fill(rect(0, 0, 40, 40), 0, GRASS, "plate", layers=2)
G = 2
fill(rect(17, 0, 23, 6), G, "Tan", "tile")             # a road up to the gate, stopping at the wall

step()
module("towers")
CORNERS = ((4, 4), (30, 4), (4, 30), (30, 30))
for x, z in CORNERS:
    tower = ring(x, z, x + 6, z + 6)
    fill(tower, G, DARK)                                # a darker plinth course
    fill(tower - {(x + 3, z), (x + 3, z + 5)}, G + 15, STONE)   # arrow slits: cells left out of one course
    fill(tower, G + 3, STONE, layers=4)
    fill(tower, G + 18, STONE, layers=5)
    roof(x, G + 33, z, 6, 6, style="crenellated", color=STONE)

module("curtain walls")
# Each wall runs between two towers and touches their sides; none covers a tower's cells.
wall(10, G, 6, 20, 24, style="castle", color=STONE, openings=[(7, 0, 6, 21)])
door(17, G, 6, style="arched", color=DARK, leaf=WOOD)
wall(10, G, 33, 20, 24, style="castle", color=STONE, facing="back")
wall(6, G, 10, 20, 24, style="castle", color=STONE, facing="left")
wall(33, G, 10, 20, 24, style="castle", color=STONE, facing="right")

step()
module("keep")
fill(ring(14, 18, 26, 28) - rect(14, 18, 26, 19), G, STONE, layers=9)   # 12 x 10; the front is a wall()
wall(14, G, 18, 12, 27, style="masonry", color=STONE, openings=[(4, 0, 4, 18)])
door(18, G, 18, style="barred", color=DARK, leaf=WOOD)
roof(14, G + 27, 18, 12, 10, style="steep_gable", color=ROOF, facing="front", gable=STONE)

module("courtyard")
tree(9, G, 12, height=24, width=4, style="round")
lamp(12, G, 9, style="torch")
lamp(27, G, 9, style="torch")
