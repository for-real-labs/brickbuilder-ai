#: title: Off-road 4x4
#: source: written for BrickBuilder
# Off-road 4x4, 6 studs wide and high: big tyres, an upright windscreen, open seats and a roll bar,
# like official 4x4 sets. The deck sits high (8 plates) so the tyres clear the body.
ROAD, BODY, TRIM = "Reddish_Brown", "Dark_Green", "Black"

module("ground")
fill(rect(-2, -2, 8, 16), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="suv", color=TRIM, rim="Light_Bluish_Grey")  # 6 x 14, deck 8: floor top y = 9
D = 9

step()
module("nose")
fill(rect(0, 0, 6, 1), D, "Dark_Bluish_Grey")           # bumper
place("3005", "Trans_Clear", 0, D + 3, 0)
place("2877", TRIM, 1, D + 3, 0)
place("2877", TRIM, 3, D + 3, 0)
place("3005", "Trans_Clear", 5, D + 3, 0)
fill(rect(0, 1, 6, 5), D, BODY, layers=2)                # tall, square bonnet
fill(rect(0, 0, 6, 5), D + 6, BODY, "tile")

step()
module("cabin")
fill(rect(0, 5, 6, 7), D, BODY, layers=2)
windscreen(1, D + 6, 5, style="upright")                 # 4 x 2 x 6, upright like a 4x4's
fill({(0, 5), (5, 5), (0, 6), (5, 6)}, D + 6, BODY, layers=2)  # frame either side of it
seats(1, D, 7, style="pair", color="Tan")
fill(rect(0, 7, 1, 11) | rect(5, 7, 6, 11), D, BODY)      # low sides: it is open
fill({(0, 10), (5, 10)}, D + 3, TRIM, layers=2)            # roll bar posts
place("3666", TRIM, 0, D + 9, 10)                          # 1 x 6 bar across the posts

step()
module("rear")
fill(rect(0, 11, 6, 14), D, BODY)
fill(rect(1, 7, 5, 11) - rect(1, 7, 5, 10), D, BODY)     # back of the seat well
place("3005", "Trans_Red", 0, D + 3, 13)
place("3005", "Trans_Red", 5, D + 3, 13)
fill(rect(1, 11, 5, 14), D + 3, BODY, "tile")
