#: title: Vintage car
#: source: written for BrickBuilder
# Vintage car, 4 studs wide: a long bonnet with a front grille, an upright windscreen, a tall cabin
# and a spare wheel's bump at the back, like official classic cars.
ROAD, BODY, TRIM = "Dark_Bluish_Grey", "Dark_Red", "Black"

module("road")
fill(rect(-2, -2, 6, 12), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="classic", color=TRIM)       # 4 x 10, deck 7: floor top y = 8
D = 8

step()
module("bonnet")
place("3005", "Trans_Clear", 0, D, 0)
place("2877", "Light_Bluish_Grey", 1, D, 0)          # chrome grille
place("3005", "Trans_Clear", 3, D, 0)
fill(rect(0, 1, 4, 4), D, BODY)
place("85984", BODY, 0, D + 3, 0, facing="front")    # rounded front edge
place("85984", BODY, 2, D + 3, 0, facing="front")
fill(rect(0, 1, 4, 4), D + 3, BODY, "tile")

step()
module("cabin")
fill(rect(0, 4, 4, 6), D, BODY)                      # dashboard the windscreen stands on
windscreen(0, D + 3, 4, style="upright")             # 4 x 2 x 6, upright: top at D + 9
fill(rect(0, 6, 1, 9) | rect(3, 6, 4, 9), D, BODY, layers=2)   # sides beside the seat
seats(1, D, 6, style="single", color="Tan")          # 2 x 3: rows 6 to 8, so nothing else goes there
fill({(0, 8), (3, 8)}, D + 6, TRIM)                  # pillars
fill(rect(0, 4, 4, 9), D + 9, TRIM, "plate")         # a black roof, like old cars
fill(rect(0, 4, 4, 9), D + 10, TRIM, "tile")

step()
module("tail")
fill(rect(0, 9, 4, 10), D, BODY)
place("3005", "Trans_Red", 0, D + 3, 9)
place("3005", "Trans_Red", 3, D + 3, 9)
fill({(1, 9), (2, 9)}, D + 3, BODY)
