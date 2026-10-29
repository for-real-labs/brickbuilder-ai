# Design from existing parts

The landing page's **Design from existing set** tab accepts Studio `.io`, LDraw
`.ldr`/`.mpd`, Rebrickable or LDraw `.csv`, and BrickLink inventory `.xml` files.
After selection, the normal image/text composer runs Nova against a finite palette.
Quantities are ceilings: Nova may leave pieces unused, but cannot add extra parts,
substitute colors, or exceed the quantity of any part/color pair.

## Inventory formats

- Custom CSV: `part_id,color_id,quantity`, using **LDraw** part and color IDs.
- BrickBuilder CSV: `LdrawId,LDrawColorId,Qty`.
- Rebrickable CSV: `part_num,color_id,quantity` or `Part,Color,Quantity`.
- Studio CSV: `Part Number,Color,Quantity`, using BrickLink color IDs.
- BrickLink XML: `INVENTORY/ITEM`, `ITEMID`, `COLOR`, `QTY` or `MINQTY`;
  individual parts only (`ITEMTYPE=P`).

Duplicate rows are summed. The checked-in `inventory_colors.csv` cross-reference
converts 143 Rebrickable and 153 BrickLink colors exactly; missing mappings fail visibly. It uses exact canonical color names from Rebrickable and the original entries in
Studio’s color definition table, resolved against official LDraw colors. Source hashes are in its metadata file. Refresh with
`backend/scripts/refresh_inventory_colors.py` and the three source files. No RGB approximation
or mold substitution is performed. LDraw imports count repeated nested submodels and
inherited colors. Root parts must have explicit colors. Embedded DAT overrides, custom
geometry/colors, unresolved submodels, recursive assemblies, XML entities and oversized
archives are rejected. Inputs are limited to 16 MB, 10,000 inventory rows and 100,000 pieces.

## Set catalog

Catalog data comes from [Rebrickable's official downloads](https://rebrickable.com/downloads/).
The importer uses `sets`, `inventories`, `inventory_parts`, `inventory_sets` and
`inventory_minifigs`. It picks the newest inventory version, expands nested sets and
minifigures, sums repeated parts, and excludes spare pieces. Incomplete nested inventories
are omitted rather than advertised as complete. The initial October 29, 2026 import
contains 21,330 complete inventories. Each database row records its source and import time.

Search reads the imported `lego_set_catalog` in Supabase. Set selection uses only
exact part IDs present in the installed LDraw library and colors with known mappings.
If any pieces are unavailable, the screen lists them and requires the user to choose
the supported pieces before continuing. Missing sets show manual-download/upload guidance.
Because a downloadable catalog exists, no AI web-search inventory reconstruction is needed.

Apply `20261029140000_lego_set_catalog.sql`, then explicitly refresh with:

```sh
python backend/scripts/import_lego_sets.py --output /tmp/lego-sets.jsonl --cache /tmp/new-rebrickable-snapshot
python backend/scripts/import_lego_sets.py --upload /tmp/lego-sets.jsonl --env-file backend/.env
```

Use a fresh cache directory for a new snapshot. The generated metadata JSON records the
source CSV hashes. Imports upsert matching set numbers and do not touch user data.
The table has RLS enabled and allows only service-role access; public backend queries
are bounded to 20 results. Local embedded PostgreSQL supports the same catalog query;
file upload works without a seeded catalog.

## Enforcement and persistence

Nova receives a protected per-chat palette with `max_quantity` for every exact pair.
Its existing publication gate enforces that palette, and BrickBuilder independently
validates the final expanded model before storage, instructions or credit deduction.
The supplier catalog continues to apply to ordinary builds without an owned inventory.

The original normalized inventory is saved privately as
`generation-output/<generation-id>/parts-inventory.json`; the generation stores only a
`has_parts_inventory` flag. Owned edits and resumes restore it before changing providers
or recovering lost sessions. An unavailable inventory blocks continuation instead of
silently removing limits. Nova session metadata also retains a copy. Public-model copies
do not expose another owner's private unused inventory.
