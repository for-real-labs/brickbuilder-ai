#: title: Police car
#: source: written for BrickBuilder
# Police car, 4 studs wide, in the proportions of official town police cars:
# wheels 2 and 9 studs from the front, windscreen 3 studs back, roof 9 plates above the floor.
ROAD, BODY, TRIM = "Dark_Bluish_Grey", "White", "Blue"

module("road")
fill(rect(-2, -2, 6, 14), 0, ROAD, "plate", layers=2)  # lay the road first: chassis() joins the tyres to it

module("chassis")
chassis(0, 1, 0, style="sedan", color="Black")   # 4 x 12; its note says deck 6, so the floor top is y = 7
D = 7

step()
module("nose")
place("3005", "Trans_Clear", 0, D, 0)            # headlights at the front corners
place("2877", "Black", 1, D, 0)                  # grille between them
place("3005", "Trans_Clear", 3, D, 0)
fill(rect(0, 1, 4, 3), D, BODY)                  # the rest of the bonnet, one brick
fill(rect(0, 0, 4, 3), D + 3, BODY, "tile")      # smooth bonnet top

step()
module("cab")
windscreen(0, D + 3, 3, style="classic")         # 4 x 2 x 6, standing on the bonnet's level: top at D + 9
seats(1, D, 5, style="single", color="Black")    # 2 x 3 seat in the middle of the 4-wide floor
sides = rect(0, 5, 1, 9) | rect(3, 5, 4, 9) | rect(1, 8, 3, 9)
fill(sides, D, TRIM)                              # a blue band at door height
fill(sides, D + 3, BODY)
fill({(0, 8), (3, 8)}, D + 6, BODY)               # back pillars carry the roof with the windscreen
fill(rect(0, 3, 4, 9), D + 9, BODY, "plate")      # roof: plates from the windscreen's studs to the pillars
place("3069b", "Trans_Red", 0, D + 10, 5)         # light bar
place("3069b", "Trans_Dark_Blue", 2, D + 10, 5)
fill(rect(0, 3, 4, 9) - rect(0, 5, 4, 6), D + 10, BODY, "tile")

step()
module("boot")
fill(rect(0, 9, 4, 11), D, BODY)
place("3005", "Trans_Red", 0, D, 11)              # tail lights
place("3004", BODY, 1, D, 11)
place("3005", "Trans_Red", 3, D, 11)
fill(rect(0, 9, 4, 12), D + 3, BODY, "tile")
