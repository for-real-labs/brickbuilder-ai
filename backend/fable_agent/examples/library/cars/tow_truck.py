#: title: Tow truck
#: source: written for BrickBuilder
# Tow truck, 6 studs wide: a cab at the front, a flat deck behind it and a crane boom stepping up
# and back over the rear, like official town tow trucks. Its deck is 10 plates up.
ROAD, BODY, TRIM = "Dark_Bluish_Grey", "Orange", "White"

module("road")
fill(rect(-2, -2, 8, 22), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="truck", color="Black", rim="Light_Bluish_Grey")  # 6 x 20, deck 10: floor top y = 11
D = 11

step()
module("front")
place("3005", "Trans_Clear", 0, D, 0)
place("2877", "Light_Bluish_Grey", 1, D, 0)
place("2877", "Light_Bluish_Grey", 3, D, 0)
place("3005", "Trans_Clear", 5, D, 0)
fill(rect(0, 1, 6, 3), D, BODY)
fill(rect(0, 0, 6, 3), D + 3, BODY, "plate")

step()
module("cab")
windscreen(0, D + 4, 1, style="wide")                 # stands on the plate over the nose: top at D + 10
seats(1, D, 3, style="pair", color="Black")
sides = rect(0, 3, 1, 7) | rect(5, 3, 6, 7) | rect(0, 6, 6, 7)
fill(sides, D, BODY)
fill(sides, D + 3, TRIM)
fill({(0, 6), (5, 6)}, D + 6, BODY)                  # back pillars, a brick and a plate,
fill({(0, 6), (5, 6)}, D + 9, BODY, "plate")          # up to the windscreen's top
fill(rect(0, 1, 6, 7), D + 10, BODY, "plate")
place("3069b", "Trans_Orange", 0, D + 11, 3)          # warning lights
place("3069b", "Trans_Orange", 4, D + 11, 3)

step()
module("deck and boom")
fill(rect(0, 7, 6, 20), D, "Dark_Bluish_Grey", "plate")
fill(rect(2, 9, 4, 11), D + 1, BODY, layers=3)         # boom base, 2 x 2
fill(rect(2, 10, 4, 14), D + 10, BODY)                 # boom steps back over the deck
fill(rect(2, 13, 4, 17), D + 13, BODY)
place("3062b", "Black", 2, D + 10, 16)                 # the hook hangs from the boom's tip
fill(rect(1, 19, 5, 20), D + 1, BODY)                 # between the tail lights
place("3005", "Trans_Red", 0, D + 1, 19)
place("3005", "Trans_Red", 5, D + 1, 19)
