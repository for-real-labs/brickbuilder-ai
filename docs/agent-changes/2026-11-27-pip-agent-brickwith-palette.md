# Pip agent checks the Brickwith Studio palette before publication

- **Date** 2026-11-27
- **Agent** Pip agent (`pip-agent` and its first release)
- **Pull request** [#428](https://github.com/for-real-labs/brickbuilder-ai/pull/428)

## What changed

Pip selects exact part and color combinations listed in both Brickwith’s downloadable Studio palette and its priced storefront. It applies the same restriction when building with a supplied inventory. The backend reads the finished LDraw placements and checks them again before saving a successful build or its instructions.

Pip parts lists and paid order snapshots include the exact Brickwith product ID and quantity. The model viewer’s BrickLink XML export uses Studio mold and color cross-references.

## Why

Brickwith’s storefront and Studio palette use different numbers for some identical molds. BrickLink also uses its own part and color numbers. A mismatched identifier could make the upload show a shortage or match a different color.

## What stayed the same

Pip keeps its existing agent ID, physical checks and credit price. Existing generations and purchases retain their saved files.

## Results

The refreshed catalog contains 32,381 exact Studio part/color pairs with a priced supplier SKU. In one 616-piece comparison, Brickwith’s importer matched all 108 lots, including their colors and quantities, through the SKU CSV and the corrected BrickLink XML. No AI generation was needed for this comparison.

## Not verified

The catalog is a dated supplier snapshot. Stock can change after publication.

## Where it lives

See `backend/scripts/refresh_brickwith_catalog.py`, `backend/src/requests/fableToBricks.py`, `backend/src/utils/supplier_catalog.py` and `frontend/src/utils/modelExport.ts`.
