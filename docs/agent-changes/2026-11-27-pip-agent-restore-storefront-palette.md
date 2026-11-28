# Pip agent returns to its original parts palette

- **Date** 2026-11-27
- **Agent** Pip agent (`pip-agent` and its first release)

## What changed

Pip again builds from the full storefront catalog by default. When someone supplies an inventory, Pip uses that inventory’s parts, colors and quantities. The additional Studio palette check introduced in [#428](https://github.com/for-real-labs/brickbuilder-ai/pull/428) has been removed from building and saving.

## Why

A BrickLink XML identifier mismatch caused the reported shortage. Brickwith accepted all 616 original pieces when given their exact supplier identifiers.

## What stayed the same

Pip’s usual build checks still run. XML downloads use the corrected BrickLink identifiers. Order snapshots carry exact supplier SKUs. Generated models with parts outside the supplier catalog can still save their complete LDraw bill of materials.

## Results

A comparison with the catalog before #428 matched all 36,374 default part/color pairs. Regression tests cover an older storefront mold number, supplied inventories and saving a complete parts list.

## Not verified

This comparison used saved catalogs and test builds. It incurred no paid model calls.

## Where it lives

See `backend/fable_agent/palette.py`, `backend/src/requests/fableToBricks.py` and `backend/src/utils/generation_storage.py`.
