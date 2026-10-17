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
The initial animations were generated in the signed-in fal.ai playground in Brave using
Kling 2.5 Turbo Pro image-to-video. See `generation-ledger.json` for exact video
prompts, source URLs, request IDs, filenames, duration and cost. Nine completed
five-second generations cost $0.35 each ($3.15 total), verified against the
account credit change from $14.53 to $11.38. No retries were charged.

The shipped animations are 512 × 512, 24 fps with alpha and no audio.
WebM files stay under 650 KB and HEVC files under 2 MB. Only the browser-selected
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
The initial Bria video background removal on fal.ai processed the nine original animations;
that first transparency pass did not regenerate the character motion. `transparency-ledger.json` records
source URLs, output URLs, request IDs, per-request costs and alpha validation.
The first Pip experiment remains documented in `transparency-preview.json`.

Each removal cost $0.705833, verified in fal.ai request history. The eight added
clips cost $5.646664; all nine removals cost $6.352497. Together with the original
animation generation, that initial phase cost about $9.50 before the loop
regeneration below.

The renderer hides the still poster once alpha playback starts, preventing it
from showing through the moving character. Pause, reduced motion or a playback
error restores the transparent still. Unsupported video browsers use that still.

`/pet-preview` compares each pet and activity with its original MP4 on
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


## Seamless loops (v2)

The original clips were prompted to loop but their final poses drifted from the
starting images. All nine activities were regenerated with Kling 2.5 Turbo Pro,
using the **same approved reference as both `image_url` and `tail_image_url`**.
The prompts ask each gesture to finish by four seconds and ease into the exact
resting pose. Building uses small assembly gestures with empty paws so props do
not remain behind at the join. Bria then removes the white background again.
No crossfade, reversed motion, frozen endpoint, or player workaround is applied.
Clik idle receives a small endpoint matte correction before HEVC encoding: the
first-minus-last residual is eased over the final 12 frames in premultiplied RGBA.
`normalize-endpoint.mjs` implements this cleanup without changing frame count or
timing; unit tests check alpha handling, preserved earlier motion and exact closure.

`seamless-loops.json` records all 18 request IDs, prompts, source URLs, provider
billable units, account pricing, output hashes and decoded measurements. The
additional provider cost is **$9.55** ($3.15 generation plus about $6.405 removal).
This is calculated from each completed request's `x-fal-billable-units` response
header and authenticated pricing, rather than inferred from a changing balance.

The new assets live in `frontend/public/pets/loops-v2/`. Versioned URLs make
browsers fetch the repaired clips after deployment. Listening still uses idle.
The old white-background MP4s remain on the preview page as the before comparison.
Each replacement contains 122 frames at 24 fps (about 5.08 seconds), is silent,
and preserves alpha in both browser formats. WebM files remain under 650 KB.
HEVC uses quality 85, full alpha quality and a final intra frame to reduce texture
changes at the join; its files remain under 2 MB. RGBA stays premultiplied before
Apple encoding. The encoding commands and current hashes in `seamless-loops.json`
supersede the original encodes in `safari-transparency.json`.

To rerun the WebM media checks (requires ffmpeg with libvpx):

```sh
cd frontend
node scripts/pets/verify-loops.mjs public/pets/loops-v2/*-alpha.webm
```

The verifier compares the decoded final and first frames on both black and white
surfaces over the visible subject, checks the six neighboring motion steps, and
requires a clear background, opaque subject and soft edges in every frame. Unit
tests cover pose jumps, sudden boundary acceleration, static/invalid clips,
invisible color data and alpha loss. Asset tests bind these measurements to the
exact shipped WebM and HEVC bytes using SHA-256.

HEVC is independently decoded with AVAssetReader, with alpha metadata and all
122 frames checked for each clip. Native Safari checks confirm all nine MOVs
remain transparent through repeated loops, plus the app preview at desktop and
375 × 812 mobile widths. Chromium app checks cover each pet/activity and confirm
that the ordered sources select the WebM version.
