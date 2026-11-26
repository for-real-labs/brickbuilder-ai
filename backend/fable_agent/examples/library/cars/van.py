#: title: Delivery van
#: source: written for BrickBuilder
# Delivery van, 4 studs wide and tall: a short bonnet, a tall windscreen and a box body with one
# roof over cab and load space, like official town vans.
ROAD, BODY, TRIM = "Dark_Bluish_Grey", "White", "Red"

module("road")
fill(rect(-2, -2, 6, 14), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="van", color="Black")      # 4 x 12, deck 6: floor top y = 7
D = 7

step()
module("nose")
place("3005", "Trans_Clear", 0, D, 0)
place("2877", "Black", 1, D, 0)
place("3005", "Trans_Clear", 3, D, 0)
fill(rect(0, 1, 4, 2), D, BODY)
fill(rect(0, 0, 4, 2), D + 3, BODY, "tile")

step()
module("cab")
fill(rect(0, 2, 4, 5), D, BODY)                    # dashboard under the windscreen
windscreen(0, D + 3, 2, style="tall")              # 4 x 3 x 9: top at D + 12, studs at its back corners
seats(1, D, 5, style="single", color="Black")
step()
module("box")
walls = rect(0, 5, 1, 12) | rect(3, 5, 4, 12) | rect(1, 11, 3, 12)
fill(walls, D, BODY)
fill(walls, D + 3, TRIM)                           # a stripe along the side
lights = {(0, 11), (3, 11)}
fill(walls - lights, D + 6, BODY)                  # leave the cells the tail lights go in
for x, z in lights:
    place("3005", "Trans_Red", x, D + 6, z)
fill(walls, D + 9, BODY)
fill(rect(0, 2, 4, 12), D + 12, BODY, "plate")     # one roof from the windscreen to the back wall
fill(rect(0, 2, 4, 12), D + 13, BODY, "tile")
