#: title: Open-wheel race car
#: source: written for BrickBuilder
# Open-wheel race car, 4 studs wide and low: a narrow nose with a front wing, an open cockpit and a
# rear wing on two posts, like official formula racers.
ROAD, BODY, TRIM = "Dark_Bluish_Grey", "Red", "White"

module("track")
fill(rect(-2, -1, 6, 15), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="racer", color="Black")     # 4 x 14, wheels outside, deck 7: floor top y = 8
D = 8

step()
module("nose")
fill(rect(0, 0, 4, 1), D, TRIM, "plate")           # front wing across the whole width
fill(rect(1, 0, 3, 5), D + 1, BODY, "plate", layers=2)   # narrow nose
place("15068", BODY, 1, D + 3, 0, facing="front")
fill(rect(1, 2, 3, 5), D + 3, BODY, "tile")
fill(rect(0, 1, 1, 5) | rect(3, 1, 4, 5), D, "Black", "tile")

step()
module("cockpit")
fill(rect(0, 5, 1, 9) | rect(3, 5, 4, 9), D, BODY)        # sidepods either side of the driver
fill(rect(0, 5, 1, 9) | rect(3, 5, 4, 9), D + 3, TRIM, "tile")
fill(rect(1, 5, 3, 6), D, BODY)                            # dashboard
seats(1, D, 6, style="single", color="Black")

step()
module("engine and wing")
fill(rect(0, 9, 4, 13), D, BODY)
fill(rect(1, 9, 3, 12), D + 3, BODY)                       # engine cover
place("15068", BODY, 1, D + 6, 9, facing="back")
fill({(0, 13), (3, 13)}, D, "Black", layers=2)             # wing posts
place("3710", TRIM, 0, D + 6, 13)                          # 1 x 4 rear wing on both posts
fill(rect(0, 12, 4, 13), D + 3, "Black", "tile")
