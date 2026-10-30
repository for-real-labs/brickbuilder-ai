# Seamless loops

Use `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, five seconds, `cfg_scale: 0.6`. Verify the current provider schema. Composite the transparent reference onto a white square with enough margin for the entire costume and prop. Upload once; put the identical URL into both `image_url` and `tail_image_url`. In the browser playground, uploading the same local file into both fields may produce different CDN URLs; verify that both uploaded files have identical SHA-256 hashes and record the actual URLs. Inspect that opaque reference before submitting. Save request IDs immediately and resume them instead of duplicating charges.

Shared prompt: “One complete five-second seamless looping animation of this exact character. [Activity.] Begin relaxed in the supplied first-frame pose. Finish the gesture by four seconds and smoothly ease into the EXACT supplied last-frame pose: same head angle, expression, hands, feet, costume and prop positions. Both ends nearly motionless. Locked camera, pure white background, stable centered full-body size and position, all limbs and props visible. Preserve anatomy and plush texture. No cuts, zoom, drifting, morphing, new objects, extra limbs or text.”

Idle: gentle breathing, one middle blink and tiny head tilt. Building: two small assembly gestures and satisfied nod. Celebrating: one small bounce/cheer and settle. Adapt these to the requested costume; retain props throughout and restore their exact positions at the join. Inspect generated motion and endpoint poses before background removal.

Remove background with `bria/video/background-removal`: `video_url`, `background_color: "Transparent"`, `output_container_and_codec: "webm_vp9"`, `preserve_audio: false`. Inspect fine edges and save the request and output URLs.

## Encode

Explicitly use the `libvpx-vp9` decoder so ffmpeg preserves alpha. Normalize to 512×512, 24 fps, no audio. Measure frame count: 122 frames was the original provider output, not a universal invariant.

WebM: `ffmpeg -c:v libvpx-vp9 -i INPUT -vf scale=512:512,fps=24 -an -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -crf 36 -b:v 0 -row-mt 1 -cpu-used 4 OUTPUT-alpha.webm`.

Apple HEVC alpha (macOS VideoToolbox): `ffmpeg -c:v libvpx-vp9 -i INPUT -an -vf scale=512:512,fps=24,format=rgba,premultiply=inplace=1,format=bgra -c:v hevc_videotoolbox -allow_sw 1 -alpha_quality 1 -q:v 85 -b:v 0 -tag:v hvc1 -force_key_frames expr:eq(n,LAST_INDEX) -movflags +faststart OUTPUT-alpha.mov`. Replace LAST_INDEX with the actual last frame index and shell-quote the expression. Premultiplication avoids bright edge halos; full alpha quality and final intra frame reduce endpoint compression drift. Keep WebM below 650 KB and MOV below 2 MB, matching current asset tests.

Keep source order: MOV `video/quicktime; codecs="hvc1"`, then WebM `video/webm; codecs="vp9"`. Safari may ignore WebM alpha; generic MP4 HEVC can make Chromium play only the opaque color layer. Hide the poster after transparent playback begins, restoring it on reduced motion, pause or failure.

## Acceptance

Use `frontend/scripts/pets/verify-loops.mjs`. It decodes every frame at 128×128, compares premultiplied RGB over the visible-subject union on black and white composites, and requires:

- Seam MAE ≤2 and ≤`median_step_mae * 0.5 + 0.35`.
- Maximum of six neighboring steps on each side ≤`max(median_step_mae * 3, 2)`.
- Median motion ≥0.05 (reject frozen footage).
- Every frame: ≥40% fully clear pixels, ≥5% fully opaque, ≥0.1% soft alpha.

Independently decode MOV using AVAssetReader to BGRA, confirm ContainsAlphaChannel metadata, unpremultiply to RGBA and apply the same `measureLoop`/assertion functions. ffmpeg's ordinary HEVC decode may expose only color. Run the bundled `scripts/decode-hevc.swift OUTPUT_DIRECTORY VIDEO.mov ...` with Swift to extract the RGBA data and alpha evidence.

For a **small matte/color residual only**, use the repository `normalize-endpoint.mjs`: ease first-minus-last residual over the final 12 frames in premultiplied RGBA. Record the pre-correction error and inspect the result. Regenerate if pose, prop, or geometry materially differs. Do not conceal failure with long dissolves, reversed footage, frozen endpoints or runtime reset tricks. Encode both formats from the same corrected lossless master and retest final bytes.

Record SHA-256 hashes and decoded metrics in a dated ledger and bind tests to those actual files. Do not weaken thresholds for a failed render. Inspect multiple complete loops on light, dark and checkerboard surfaces in native Safari and Chromium, including mobile layout. Metrics do not catch every visual flaw. Report only checks actually performed and distinguish estimated from verified provider cost.
