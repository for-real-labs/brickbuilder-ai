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

`frontend/public/pets/` contains three WebP posters and nine silent MP4 clips.
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

The shipped videos are 512 × 512, 24 fps, H.264/yuv420p with fast-start metadata
and no audio. The white studio background blends into the light companion
surfaces using multiply blending. The original high-resolution generations and
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

## One-animation transparency preview

The `codex/pip-transparent-preview` experiment replaces only Pip's idle clip
(also used while listening) with `frontend/public/pets/pip-idle-alpha.webm`.
The original MP4 stays available for the before/after view at `/pet-preview`.
The other eight animations retain their existing assets and rendering.

Bria video background removal on fal.ai removed the existing clip's background;
the character animation was not regenerated. Processing cost $0.70, bringing
the total fal.ai spend for these pets to $3.85. The source and request are recorded
in `transparency-preview.json`.

The preview uses real VP9 alpha at 512 × 512 and 24 fps (about 230 KiB). Its
renderer uses normal compositing and hides the static poster once playback
starts, so the poster cannot show through the moving character's transparent
edges. Pausing or a playback error restores the transparent still poster.
Browsers that cannot play the WebM use that still artwork.

Visual checks cover checkerboard, cream and dark backgrounds at mobile and
desktop widths. The alpha channel was also decoded at five points in the clip:
each sample retained a clear background, opaque character pixels and soft edges.
