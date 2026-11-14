# Real-photo evaluation — November 13, 2026 (America/Chicago)

Both examples used actual publicly licensed camera photographs, live SAM 3 on the existing production fal.ai account, and live Brickognize recognition. No synthetic image or mocked provider response was used for recognition. Browser layout verification replayed the recorded real results through local test-only request interception; no bypass is included in application code.

## Sources and permissions

1. [LEGO bricks in Loviisa.jpg](https://commons.wikimedia.org/wiki/File:LEGO_bricks_in_Loviisa.jpg), JIP, August 3, 2022. [Original JPEG](https://upload.wikimedia.org/wikipedia/commons/e/e2/LEGO_bricks_in_Loviisa.jpg), 4608 × 3456. Licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Evaluated an unscaled 1600 × 1350 crop at original bounds `(2150, 400, 3750, 1750)`, containing loose floor pieces, overlaps, assembled objects and parts in containers. This is a difficult spread, not an independently established 100-piece ground-truth set.
2. [Lego bricks.jpg](https://commons.wikimedia.org/wiki/File:Lego_bricks.jpg), Benjamin D. Esham / Wikimedia Commons, January 2, 2008, photographed with a Canon PowerShot S3. [Original JPEG](https://upload.wikimedia.org/wikipedia/commons/1/19/Lego_bricks.jpg), 2816 × 2112. Licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Used the whole photo of a dense, overlapping pile; its exact physical piece count was not established.

Local overlays, masked crops and screenshots are adaptations of these images, licensed CC BY-SA 4.0 with the respective attribution above. Changes: cropping, resizing, segmentation masking, numbering and UI annotation. The photos and generated image artifacts are not committed to the application or publicly hosted by it.

## Observations

| Run | Tiles | Regions after deduplication | Tentative identified regions | Unique proposed part IDs | Unmatched | Time | Removed duplicates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Floor spread, initial box-based deduplication | 4 | 110 | 43 | 40 | 67 | 50.2 s | 18 |
| Dense pile, box-based deduplication | 9 | 183 | 72 | 48 | 111 | 38.5 s | 42 |
| Dense pile, final mask-based deduplication | 9 | 134 | 52 | 37 | 82 | 35.5 s | 91 |

These are observations, not accuracy percentages. Similarity scores are uncalibrated: 41 of the 43 initial spread matches were below 0.8. No dense-pile match reached 0.8. No Brickognize request failed or returned a retryable rate limit in these runs. Rate-limit and partial-failure behavior were separately tested with deterministic provider fixtures.

The four floor-spread tiles all hit the 32-mask limit. Many small/occluded pieces remained undetected, and the large gray baseplate was mostly missed. The model detected a tile-edge corner of that baseplate as region 39, for which Brickognize proposed a wedge plate (`6106`): a clear example of incomplete geometry producing a questionable identity. Region 37 included an assembled minifigure rather than an individual part. Initial regions 2 and 6 were duplicate partial views of the same green piece, motivating pixel-mask deduplication. More dense overlaps and assemblies still require review. In the dense-pile photo no tile hit the output cap, but occluded/edge-truncated bricks and fragments remained problematic; removing duplicate observations does not establish the true count.

### Manual subset check

A manageable subset of **eight visually distinct objects** was selected in the upper-left area of the floor-spread crop. Their approximate centers (in crop pixels), initial region IDs, and recognition outcomes:

| Visible object | Center | Region | Outcome |
| --- | --- | --- | --- |
| Long dark-red plate-like piece | 480,169 | 76 | Unmatched |
| Red square piece | 528,236 | 105 | Unmatched |
| Gray slope | 601,190 | 98 | `3040old`, similarity 0.530; exact underside variant cannot be verified from this photo |
| Yellow small brick | 458,327 | 92 | Unmatched |
| Yellow rectangular tile | 527,337 | 64 | Unmatched |
| Brown cylindrical piece | 574,293 | 100 | Unmatched |
| Black upright/lever-like piece | 663,318 | 93 | `30153` jewel, similarity 0.509; visually questionable |
| Black sloped piece | 159,379 | 66 | Unmatched |

All eight selected objects had a detection. This deliberately chosen, easier subset is not representative of the whole photo and supplies no overall recall or identification accuracy estimate. A nearby wood knot at about `(713,223)` was also detected (region 74), demonstrating a false positive. The touching red/green pair near `(120,200)` was missed. Physical separation and exact catalog IDs would require better photos or hands-on verification.

## Cost and latency

The API result did not expose an actual billed dollar amount. Observed cost is therefore **unknown**, not zero. The successful evaluations used 4 + 9 + 9 segmentation calls and 110 + 183 + 134 crop recognition calls; an additional one-tile SAM schema diagnostic was made. There was also an unsuccessful run using a stale local credential before the existing production credential was loaded. Measured times above include segmentation, mask preparation and recognition, excluding image download and browser rendering. These samples do not establish performance for 1,000-piece photos.

## Validation and artifacts

- Backend tests cover JWT-only allowlisting, all private endpoint families, ownership, non-cacheable images, upload/active-job limits, review, alternate matches, tile coverage, masks, seam deduplication, partial failures, Retry-After, worker concurrency and cancellation with partial segmentation.
- Frontend tests cover hidden navigation, server-gated upload, account-switch cleanup, grouping, exclusions, cancellation, image preparation and authenticated API transport.
- Browser checks at 1440 × 1000 and 390 × 844 found no horizontal overflow or page JavaScript errors. Inspected photo overlays, crop contact sheets and the parts grid. Catalog thumbnails fall back to authenticated crops if loading fails.
- Local evidence: `output/photo-scanner/` (floor spread, contact sheet, overlay, desktop/mobile screenshots, raw results) and `output/photo-scanner-second/` (dense pile, final results and screenshots). These directories are intentionally untracked.
