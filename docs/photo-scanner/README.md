# Private Photo Scanner prototype

`/photo-scanner` is a separate tool for the authenticated `jake@brickbuilder.ai` account. The Tools dropdown shows the link only to that account. Every backend route (including original photos and crop images) independently requires a verified account JWT and checks ownership. Guest sessions, developer API keys, and local anonymous mode cannot bypass this check. The public existing-parts uploader is unchanged.

## Pipeline and operating limits

The existing server `FAL_KEY` configuration creates a dedicated async fal client. No provider credentials, scan photos, or crop data go into analytics. The page explains that fal.ai receives photos and Brickognize receives crops.

Phone uploads reuse `prepareImageUpload`, with a scanner-specific larger size allowance to preserve detail. The server validates the decoded image, applies EXIF orientation, strips metadata on re-encoding, and rejects uploads over 16 MiB or 40 megapixels. JPEG, PNG, WebP and the first GIF frame work directly; the existing browser utilities convert HEIC/HEIF/TIFF and other supported browser formats.

SAM 3 gets up to nine overlapping tiles, each explicitly requesting `max_masks: 32`, multiple masks, boxes and scores. **The live OpenAPI schema specifies a maximum of 32, not merely a default of 3.** Data-URI inputs and synchronous data-URI mask outputs avoid public application photo URLs. Crops use original-resolution pixels and white backgrounds outside the observed masks; occluded geometry is not reconstructed. Foreground overlap across tiles removes likely duplicate observations, including partial tile-edge observations. This heuristic is imperfect and can still merge or duplicate detections.

Brickognize receives one isolated crop per region, with two workers, 30-second HTTP timeouts and up to four attempts on 429/503. Workers share a cooldown honoring numeric or HTTP-date Retry-After, bounded to 1–60 seconds. A failed crop remains visible while other crops finish. Alternatives belong to a single region and never increase quantity. Cancellation stops workers, requests fal queue cancellation where possible, and retains completed and detected partial results. Already-running provider work may still incur charges.

The UI groups selected identities, keeps unresolved regions visible, links quantities to photo regions, and supports candidate selection, a manual part-number/name correction, clear-match and reversible exclusion. Similarity is shown as the provider's score, not a calibrated accuracy probability. The 0.8 UI review flag is a heuristic. Colors are not predicted or claimed. An identified region is not proof of a correct part or a complete inventory.

## Storage and deployment

This deliberately small prototype uses **one process / one replica**, consistent with the current backend deployment. It admits one active scan and retains at most two jobs, available for up to one hour. A restart or deployment clears them. Do not scale this implementation horizontally without moving jobs, assets and cancellation into a shared authenticated store/queue. Session storage contains only the latest scan ID, scoped to the account; images are fetched with bearer authentication into revocable blob URLs. Responses use `private, no-store`.

No Brickscope source was present in this checkout, the main working checkout, or the searched worktrees when implemented. No other worktree was modified. This implementation does not import or rely on Brickscope's background detector.

## Real-photo evaluation

See [evaluation.md](evaluation.md). The prototype is useful for measuring failures and reviewing candidates; the observed recognition results do not justify presenting it as an exact inventory tool. Commercial permission and quotas for Brickognize remain unconfirmed.

## Reference contracts

- [fal SAM 3 documentation](https://fal.ai/models/fal-ai/sam-3/image/api)
- [fal live OpenAPI schema](https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/sam-3/image)
- [Brickognize API documentation](https://api.brickognize.com/docs)
- [Brickognize OpenAPI schema](https://api.brickognize.com/openapi.json)

The parts endpoint currently identifies itself as legacy/deprecated but remains available, matching the existing integration. Its `query_image` multipart field is used without requesting color predictions.
