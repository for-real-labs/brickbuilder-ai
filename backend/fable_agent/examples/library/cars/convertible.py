#: title: Sports convertible
#: source: written for BrickBuilder
# Sports convertible, 6 studs wide and low: a curved windscreen, two seats in the open and a spoiler,
# like official town convertibles. The floor is 7 plates up, the body only one brick above it.
ROAD, BODY, TRIM = "Dark_Bluish_Grey", "Yellow", "Black"

module("road")
fill(rect(-2, -2, 8, 16), 0, ROAD, "plate", layers=2)

module("chassis")
chassis(0, 1, 0, style="sports", color=TRIM, rim="Light_Bluish_Grey")  # 6 x 14, deck 7: floor top y = 8
D = 8

step()
module("nose")
place("3024", "Trans_Clear", 0, D, 0)               # headlights, one plate tall
place("3024", "Trans_Clear", 5, D, 0)
fill(rect(1, 0, 5, 1), D, TRIM, "plate")
fill(rect(0, 1, 6, 4), D, BODY, "plate")
for x in (0, 2, 4):
    place("15068", BODY, x, D + 1, 0, facing="front")   # curved 2 x 2 slopes round the nose
fill(rect(0, 2, 6, 4), D + 1, BODY, "plate", layers=2)
fill(rect(0, 2, 6, 4), D + 3, BODY, "tile")

step()
module("cockpit")
fill(rect(0, 4, 6, 6), D, BODY)                      # scuttle under the windscreen
windscreen(0, D + 3, 4, style="curved")              # 6 x 3 x 3; nothing goes on top of it
seats(1, D, 7, style="pair", color="Black")          # open seats behind it
fill(rect(0, 7, 1, 10) | rect(5, 7, 6, 10), D, BODY)  # door sills
fill(rect(0, 7, 1, 10) | rect(5, 7, 6, 10), D + 3, BODY, "tile")

step()
module("tail")
lights = {(0, 13), (5, 13)}
fill(rect(0, 10, 6, 14) - lights, D, BODY)         # leave the cells the tail lights go in
for x, z in lights:
    place("3005", "Trans_Red", x, D, z)
fill({(1, 13), (4, 13)}, D + 3, TRIM)                 # spoiler posts
place("3666", TRIM, 0, D + 6, 13)                    # 1 x 6 spoiler resting on both posts
fill(rect(0, 10, 6, 13), D + 3, BODY, "tile")
