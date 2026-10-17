# Build buddies

Pip, Nib and Clik share a persistent companion selector in the application shell.
The selected buddy appears beside the landing prompt and model edit prompt. When
that greeting scrolls out of view, a compact companion appears at the lower left.
On smaller purchase pages it sits above the fixed order controls.

The choice and animation preference are stored on the device. Blocked storage
falls back to an in-memory choice. The animation respects reduced motion, pauses
in hidden tabs and offscreen, and falls back to still artwork on media failure.
Only the selected visible pet loads a clip. The picker uses still images.

## Media

`frontend/public/pets/` contains three WebP posters and nine silent animations in both VP9 alpha WebM
and Apple HEVC alpha QuickTime formats,
plus the original MP4s for comparison.
Each pet has `idle`, `building` and `celebrating` clips. Listening uses the idle
clip while the prompt is focused. A successful build or edit plays a five-second
celebration; a failed request returns to idle.

The approved concept board was isolated into three character images using the
built-in imagegen tool, with the board as an identity reference. Each request
specified the selected character's exact colors, face, proportions and plush
texture, empty hands, a full-body neutral pose, a transparent background, and no
text or other characters. The individual descriptors were:

- Pip: red brick-shaped plush, single cylindrical stud, cream mittens, dark red
  feet, black bead eyes and a tiny curved smile.
- Nib: chestnut beaver, cream muzzle and tummy, two teeth, rounded ears and a
  broad navy paddle tail with subtle brick seams.
- Clik: navy baby dragon, cream tummy, small wings with red membranes, red stud
  bumps on its back and a curled tail.

The exact imagegen prompts are saved in `image-prompts.json`.

These images were padded consistently onto white reference canvases for fal.ai.
All animation was generated in the signed-in fal.ai playground in Brave using
Kling 2.5 Turbo Pro image-to-video. See `generation-ledger.json` for exact video
prompts, source URLs, request IDs, filenames, duration and cost. Nine completed
five-second generations cost $0.35 each ($3.15 total), verified against the
account credit change from $14.53 to $11.38. No retries were charged.

The shipped animations are 512 × 512, 24 fps with alpha and no audio.
WebM files stay under 650 KB and HEVC files under 1.2 MB. Only the browser-selected
format loads. Both use normal alpha compositing on every app surface. The original high-resolution generations and
visual QA evidence are preserved locally under
`/Users/jakejohnson/.codex/artifacts/brickbuilder-pets-01a146dc/`.

## Verification

The frontend suite covers persistent selection, invalid or blocked storage,
cross-tab changes, motion preferences, media failures, successful/failed build
states, route changes, edit conversations, and the presence and size of every
shipped media file. Browser checks cover the landing conversation, picker,
companion on secondary pages, and the generated model editor at desktop and
mobile widths. Model-page visual checks use an isolated local fixture API;
they do not submit paid model-generation or edit requests.

## Transparent animations

Pip, Nib and Clik use transparent video for idle/listening, building and celebrating.
Bria video background removal on fal.ai processed the nine existing animations;
the character motion was not regenerated. `transparency-ledger.json` records
source URLs, output URLs, request IDs, per-request costs and alpha validation.
The first Pip experiment remains documented in `transparency-preview.json`.

Each removal cost $0.705833, verified in fal.ai request history. The eight added
clips cost $5.646664; all nine removals cost $6.352497. Together with the original
animation generation, total pet spend is about $9.50 of the $200 budget.

The renderer hides the still poster once alpha playback starts, preventing it
from showing through the moving character. Pause, reduced motion or a playback
error restores the transparent still. Unsupported video browsers use that still.

`/pet-preview` compares each pet and activity with its matching original MP4 on
checkerboard, cream or midnight backgrounds. Browser checks verify all nine clips
start at 512 × 512 and hide their poster. Decoding alpha at five points per clip
confirms clear background, opaque subject and soft edges. Mobile and desktop
layouts were checked in Chromium and native Safari.

## Safari / Apple video support

Safari can play VP9 WebM without compositing its alpha channel. Each animation
also ships as HEVC with alpha in QuickTime. `petVideoSources` lists that source
first with `video/quicktime; codecs="hvc1"`; Safari selects it and Chromium skips
that MIME type in favor of WebM. This avoids browser-name detection and avoids
Chromium selecting an HEVC color layer without its alpha layer.

The HEVC files were transcoded locally from the existing alpha WebM files using
Apple VideoToolbox, with no additional fal.ai charges. RGBA is premultiplied before
encoding to match Apple's default alpha mode and prevent bright edge fringes.
The exact command, file hashes and decoded alpha samples are recorded in
`safari-transparency.json`. AVFoundation confirms alpha metadata and verifies
five decoded frames for all nine clips. Unit tests check both HEVC parameter-set
layers, source ordering, state changes, and poster fallback after source failures.
Native Safari checks cover all nine MOV files on checkerboard/dark backgrounds,
plus the app's comparison page at desktop and 375px mobile widths. Native Chrome
checks confirm all nine source pairs select and play their WebM version.
