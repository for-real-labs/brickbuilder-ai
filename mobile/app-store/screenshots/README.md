# App Store Connect screenshots

Each device folder contains **exactly three** portrait marketing screenshots,
numbered in upload order. The navy background and coral ribbon form one
continuous panorama across the three images.

- `iphone-6.3`: 1206 × 2622 px (portrait, required medium Dynamic Island display)
- `iphone-6.5`: 1242 × 2688 px (portrait, 6.5-inch display)
- `iphone-6.9`: 1320 × 2868 px (portrait, 6.9-inch display)
- `ipad-13`: 2064 × 2752 px (portrait, 12.9-inch or 13-inch display)

Upload these three files in this order, replacing the previous five images:

1. `01-imagine.png` — “Dream it. Brick it.” Photo/text creation and a real model.
2. `02-create.png` — “Make it uniquely yours.” Model viewer and editing controls.
3. `03-explore.png` — “Find your next build.” Bat Cave and community discovery.

The matching `brickbuilder-*-screenshots.zip` archives are in `mobile/app-store/`.
Only the three numbered PNGs belong in the App Store upload slots. The
`preview-*.jpg` contact sheets are for reviewing the sequence together.
All three captions describe LEGO-compatible models or builds, matching the
App Store subtitle and description.

The accompanying English (U.S.) subtitle is in
`../metadata/en-US/subtitle.txt`. The subtitle and screenshots were submitted
to Apple in version 1.0.1 and are Waiting for Review; see `../metadata/README.md`.

All exported PNGs are opaque RGB images. Dimensions follow
[Apple’s screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/).

## Recreate the assets

The editable layout is `../design/render.py`. It uses the bundled Manrope font
(SIL Open Font License included), an exported Knapp Center model render, and focused
crops of the real app captured on October 15, 2026. Captures show a typed prompt
and edit suggestion; generating or applying an edit was not required.

The hero model is [Knapp Center](https://brickbuilder.ai/generated-model?id=e3438737-7c21-4d67-9d04-b19412fe3ca2)
and the AI refinement example is [Santa Claus](https://brickbuilder.ai/generated-model?id=1ee7a270-74d2-435c-b401-d4254470b15b).
The third image features the original [Bat Cave community model](https://brickbuilder.ai/generated-model?id=923b8062-6a0c-4313-9d4e-8ce157b7a379)
using its existing gallery render, plus a real crop of the community search controls.
The model feature card is marketing artwork, and the controls are an app capture.
The iPad refinement layout arranges two focused app crops as separate floating cards.
The previous Link character is excluded from all exports.

With Python, Pillow, and numpy installed:

```sh
python3 mobile/app-store/design/render.py
python3 -m unittest discover -s mobile/app-store/design/tests -v
```

The renderer replaces PNGs only inside its four dedicated output folders and
rebuilds the ZIPs and preview sheets. Keep all images in each set in the same
order to preserve the shared background. These are screenshot assets; a new app
binary is not needed to generate them. App Store Connect may require a new
editable version before replacing screenshots on an already released version.

The public privacy policy URL is `https://brickbuilder.ai/privacy` after the frontend is deployed.
