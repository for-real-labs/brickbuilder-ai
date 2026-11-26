#: title: A small black robotic drone built from hinge plates, control sticks, and round light pieces.
#: source: LDraw Official Model Repository, 6931-1.mpd, section 6931 - robot.ldr
#: author: Orion Pobursky [OrionP]
#: licence: Redistributable under CCAL version 2.0 : see CAreadme.txt
#: description: by Carlos Antelo (ldraw-nova annotations), CC BY-SA 4.0
#: changes: converted to a BrickBuilder build script; moved to stand on the ground; 12 of 14 parts kept (minifigures, overlapping and unattached parts left out)
place("3937", "Black", 1, 0, 1)
place("3938", "Black", 1, 1, 1)
place("4070", "Black", 1, 3, 1, rot=90)
place_ldu("4735", "Black", (8, -38, 30), (0, 1, 0, -0.966, 0, -0.259, -0.259, 0, 0.966))
place("4070", "Black", 2, 3, 1, rot=270)
place_ldu("4735", "Black", (72, -38, 30), (0, -1, 0, 0.966, 0, -0.259, 0.259, 0, 0.966))
place("3794a", "Black", 1, 6, 1)
place("4733", "Black", 1.5, 7, 1)
place_ldu("4592", "Black", (58, -70, 30), (0, -1, 0, 0, 0, -1, 1, 0, 0))
place_ldu("4592", "Black", (22, -70, 30), (0, 1, 0, 0, 0, -1, -1, 0, 0))
place_ldu("6141", "Trans_Yellow", (40, -70, 12), (1, 0, 0, 0, 0, -1, 0, 1, 0))
place_ldu("6141", "Trans_Yellow", (40, -70, 48), (1, 0, 0, 0, 0, 1, 0, -1, 0))
