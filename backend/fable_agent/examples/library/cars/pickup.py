#: title: Pickup truck
#: source: written for BrickBuilder
# Pickup truck, 6 studs wide: wheels outside the body, a cab of 5 rows and an open bed of 5 rows,
# in the proportions of official pickups (wheelbase about 8 studs, cab roof 9 plates above the floor).
ROAD, BODY = "Dark_Bluish_Grey", "Red"

module("road")
fill(rect(-2, -2, 8, 18), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="pickup", color="Black", rim="Light_Bluish_Grey")  # 6 x 16, deck 7: floor top y = 8
D = 8

step()
module("nose")
place("3005", "Trans_Clear", 0, D, 0)
place("2877", "Black", 1, D, 0)
place("2877", "Black", 3, D, 0)
place("3005", "Trans_Clear", 5, D, 0)
fill(rect(0, 1, 6, 5), D, BODY)
fill(rect(0, 0, 6, 5), D + 3, BODY, "tile")

step()
module("cab")
fill(rect(0, 5, 6, 7), D, BODY)                     # dashboard row the windscreen stands on
windscreen(0, D + 3, 5, style="wide")               # 6 x 2 x 6, studs along its back edge: top at D + 9
seats(1, D, 7, style="pair", color="Tan")           # 4 x 3, between the doors
doors = rect(0, 7, 1, 10) | rect(5, 7, 6, 10) | rect(0, 10, 6, 11)
fill(doors, D, BODY, layers=2)                      # doors and back wall, two bricks
fill({(0, 10), (5, 10)}, D + 6, BODY)               # back pillars
fill(rect(0, 5, 6, 11), D + 9, BODY, "plate")       # roof, from the windscreen's studs to the pillars
fill(rect(0, 5, 6, 11), D + 10, BODY, "tile")

step()
module("bed")
fill(rect(0, 11, 1, 16) | rect(5, 11, 6, 16), D, BODY)   # bed sides
place("3005", "Trans_Red", 0, D + 3, 15)                  # tail lights on the corners
place("3005", "Trans_Red", 5, D + 3, 15)
fill(rect(1, 15, 5, 16), D, BODY)                        # tailgate
fill(rect(1, 11, 5, 15), D, "Dark_Bluish_Grey", "tile")  # smooth bed floor
