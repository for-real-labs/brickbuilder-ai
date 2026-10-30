---
name: create-edit-brickbuilder-pet
description: Create or edit BrickBuilder.ai website build buddies, including Pip, Nib, and Clik, using identity-preserving artwork and seamless transparent animation loops. Use for costumes, new buddies, and animation repairs; ChatGPT Work pets use their own pet skills.
---

# Create Edit BrickBuilder Pet

Use the existing BrickBuilder pet implementation and preserve the requested character scope. A Pip-only request must leave Nib and Clik's artwork, videos, and behavior intact. Deployment requires authorization from the current conversation; creating a pet does not itself authorize merging or production changes.

## Establish the source

Inspect `docs/pets/README.md`, `frontend/src/pets.ts`, `PetCompanion.tsx`, `frontend/scripts/pets/verify-loops.mjs`, and the current media ledger/tests. Read the detailed [loop and encoding procedure](references/seamless-loops.md) before generating video. The source chat is `01a146dc-87fa-7b52-940c-43e464c98b7c`, “Create a Brickbuilder.ai mascot.” Original working evidence is under `~/.codex/artifacts/brickbuilder-pet-loops-20261017/` when available; the skill must remain usable without those artifacts.

## Artwork and animation

Use the imagegen skill and built-in image tool for a transparent character image, inspecting the existing poster first. Preserve recognizable anatomy, texture, face, and colors while adding the requested costume. Fit every prop and the complete silhouette within the frame, with margin for motion. Inspect the result before paying for animation. Save the exact image prompt.

Generate only the requested activities (normally idle, building, celebrating; listening reuses idle). Use fal.ai Kling 2.5 Turbo Pro image-to-video, with the **same opaque white reference canvas URL in both `image_url` and `tail_image_url`**. Prompts finish the gesture by four seconds and ease into the exact resting pose. Props must remain consistent and return to the same positions. Locked camera, centered full body, stable size, pure white background, no scene changes.

Remove the white background using Bria video background removal. Ship local silent VP9 WebM alpha and Apple HEVC QuickTime alpha; keep the existing source order and poster fallback. Use new versioned URLs for changed assets, including the poster, so cached files cannot hide the update. Do not alter other characters to force a shared path.

## Completion

Decode and validate every shipped format, including alpha, boundary motion and file hashes. Inspect repeated playback on light, dark, and checkerboard backgrounds, in Safari and Chromium, at desktop and mobile widths. A matching final still alone does not prove a clean loop. Preserve reduced-motion, hidden/offscreen pausing, still fallback, and selected-pet loading.

Record inputs, request IDs, output URLs, actual cost when available (otherwise clearly labeled estimates), encoding, hashes and metrics in a dated `docs/pets/` ledger. Reuse saved request IDs on resume; inspect failed jobs before submitting replacements. Retry a failed activity selectively, with at most two paid regeneration attempts per activity before reporting the concrete quality issue and asking for direction. Run relevant tests/build and follow the user's deployment instruction. Verify production assets by bytes/hash and actual browser playback before claiming the change is live.
