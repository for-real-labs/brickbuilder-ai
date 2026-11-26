#: title: A small bird model with white and black sloped body, a red clip wing, and a yellow beak.
#: source: LDraw Official Model Repository, 31038-1.mpd, section 31038 - Bird.ldr
#: author: Marc Giraudet [Mad_Marc]
#: licence: Redistributable under CCAL version 2.0 : see CAreadme.txt
#: description: by Carlos Antelo (ldraw-nova annotations), CC BY-SA 4.0
#: changes: converted to a BrickBuilder build script; moved to stand on the ground; 7 of 7 parts kept (minifigures left out)
place("6141", "Yellow", 1, 0, 0)
place_ldu("54200", "White", (20, -22, 10), (0, 1, 0, 0, 0, -1, -1, 0, 0))
place_ldu("11477", "Black", (20.341, -24.588, 0), (0.259, 0, -0.966, -0.966, 0, -0.259, 0, 1, 0))
place_ldu("11477", "Black", (20.341, -24.588, 20), (-0.259, 0, -0.966, 0.966, 0, -0.259, 0, -1, 0))
place("4733", "Black", 1, 1, 0)
place_ldu("61252", "Red", (30, -40, 10), (0, 0, -1, 0, 1, 0, 1, 0, 0))
place("54200", "White", 1, 5, 0, rot=270)
