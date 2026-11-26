#: title: Traffic light with red, yellow, and green round trans signals on a roadsign base.
#: source: LDraw Official Model Repository, 4431-1.mpd, section 4431 - trafic light.ldr
#: author: Robert Paciorek [bercik]
#: licence: Redistributable under CCAL version 2.0 : see CAreadme.txt
#: description: by Carlos Antelo (ldraw-nova annotations), CC BY-SA 4.0
#: changes: converted to a BrickBuilder build script; moved to stand on the ground; 8 of 8 parts kept (minifigures left out)
place("30256", "Light_Bluish_Grey", 0.5, 0, 0.5)
place("30069", "Black", 1, 15, 1, rot=270)
place_ldu("6141", "Trans_Green", (44, -134, 30), (0, -1, 0, 1, 0, 0, 0, 0, 1))
place("30069", "Black", 1, 18, 1, rot=270)
place_ldu("6141", "Trans_Yellow", (44, -158, 30), (0, -1, 0, 1, 0, 0, 0, 0, 1))
place("30069", "Black", 1, 21, 1, rot=270)
place_ldu("6141", "Trans_Red", (44, -182, 30), (0, -1, 0, 1, 0, 0, 0, 0, 1))
place("49668", "Black", 1, 24, 1, rot=270)
