# Supplier parts restrictions and pricing

All parts generation and every Nova edit now use the Brickwith catalog. This
uses native restrictions in the pinned Nova forks. The toolkit owns
the generic palette reader and physical inventory expansion; the Nova agent
service owns `ChatPartsPolicy`, discovery tools and the publication gate.
BrickBuilder owns the Brickwith catalog, refresh script and pricing. It supplies
only a price-free availability palette through its private integration and
independently checks imports. Neither Nova repository contains supplier data or
prices, and Nova makes no supplier requests.

## Source and refresh

Brickwith publishes an [official Studio palette](https://www.brickwith.com/en/about/help/article/how-do-i-reference-your-part-library-in-a-design-application-like-studio).
Its March 2026 file contains 36,912 part/color entries. No documented developer
API was found. Its public storefront uses anonymous read endpoints:

- `POST https://server.brickwith.com/medusa_api/store_v2/part_main/find_list`
  with `sql_category=getTotal` or `getList`.
- `POST https://server.brickwith.com/medusa_api/store_v2/part_main/find_map_array`
  with `spu_code_array` and `part_sub_len` for complete color variants.

These POSTs read catalog data; they do not create carts, orders or accounts.
Color references come from the JSON embedded in a public product page. The
refresh script reads this data without executing downloaded scripts.

Run from the repository root:

```sh
python backend/scripts/refresh_brickwith_catalog.py
```

Commit the resulting `backend/src/data/brickwith_parts.csv` and
`brickwith_parts.metadata.json`, then deploy the API. Refresh is an explicit
operation, so normal generation and price requests make no supplier network
calls. Metadata records fetch time, sources, counts and a SHA-256 digest. The
script verifies the total product count, unique SKUs, complete variants, valid
prices and unambiguous LDraw mappings before replacing the existing CSV.
Undocumented endpoint or schema changes stop the refresh.

The October 7, 2026 snapshot includes 1,721 products and 41,664 variants. Of these,
36,374 map to exact LDraw part/color pairs. The remaining 5,290 variants retain
their SKU, price and weight in the CSV but cannot authorize a generation. This
includes Gobricks-only molds/colors and sample items without official mappings.
Only the storefront's canonical LDraw part IDs are used; no approximate mold,
alias or color substitutions are inferred from a similar name or RGB value.

## Why there are three layers

1. **Design guidance and discovery.** The runtime adds a mandatory system
   instruction, a workspace `allowed-parts.csv`, and `list_allowed_parts`.
   Search results include exact LDraw IDs/colors, opaque inventory groups and
   optional quantity limits. The agent queries this instead of loading thousands of
   entries into every prompt. `check_model_parts` provides actionable failures.
2. **Publication gate.** When Nova's publication tool has captured a candidate
   revision, Nova expands its captured source bytes through its parser. This handles
   nested subassemblies, repeated occurrences and inherited colors. Every
   physical placement must be allowed. Unavailable combinations or excess
   quantities raise a tool error before publication; the agent can repair and
   retry in the same turn. Geometry warnings do not weaken this check.
3. **Import gate.** BrickBuilder independently checks the exported flat model
   before storing it or charging a generation credit. This also protects against
   an alternate publication path bypassing the normal tool.

Custom color declarations, raw custom geometry and embedded DAT overrides are
rejected. They could otherwise impersonate an allowed SKU. These restrictions
prove catalog membership, not physical buildability; Nova's geometry and visual
review remain necessary.

The authoritative per-chat catalog is stored under the owner's protected Nova
config directory, outside the agent sandbox. Editing the workspace reference
does not change authorization. Every generation/edit supplies a fresh palette;
old unrestricted sessions must repair existing unsupported parts before their
next publication. Session metadata records the full catalog hash, exported palette
hash and pair count. Supplier names, SKUs, prices, weights and metadata remain in
BrickBuilder; shared quantity groups are exported under opaque identifiers.
Nova strips unknown columns before storing palettes, including older per-chat
snapshots on their next turn.

Rebuild both the API and Nova service when deploying this change. Runtime
readiness requires `parts_catalog_version=1`, so an old runtime fails visibly
before generation. The local image tag changes to force a rebuild. Catalog
refreshes alone need only an API deployment: it supplies the palette to the runtime.

## Staging deployment boundary

Both Nova forks now provide these changes on their staging branches. BrickBuilder
fetches immutable commits, not branch heads. Its `backend/setup_nova.cjs` pins both
matching revisions, and the generated runtime Dockerfile fetches those exact SHAs.

Railway's existing `lego stuff` staging environment runs both `nova` and
`brickai-backend`. Both services deploy from `jjohnson5253/brickbuilder-ai` staging.
The backend connects to `http://nova.railway.internal:8000` within this environment.
Merging Nova's staging branches alone does not redeploy those pinned consumers.
Merge the BrickBuilder PR into staging to rebuild the runtime and API there.
The normal frontend staging deployment then uses that staging backend.

Standalone Nova is unrestricted when no palette is configured. Set
`NOVA_PARTS_PALETTE=/absolute/path/to/allowed-parts.csv` on Nova to restrict new
chats to a local file, or supply a per-chat palette through its native
`PUT /api/chats/<id>/parts-catalog` endpoint. The file requires `part_id,color_id`
and optionally `name,sku,max_quantity`; extra columns are discarded. The legacy
`NOVA_PARTS_CATALOG` variable remains an alias for an absolute external path.
There are no built-in supplier presets. Existing restricted chats retain their
protected palettes. BrickBuilder always supplies its selected palette explicitly.
Nova's `docs/parts-catalog.md` describes native configuration.

## Another supplier or a finite inventory

Set `NOVA_PARTS_CATALOG=/absolute/path/to/catalog.csv` on the BrickBuilder API.
The same selected catalog is used for generation restrictions and pricing.
Only its availability projection is sent through the private, tenant-scoped
runtime endpoint; prices remain in the API. Unauthenticated public clients
cannot configure the runtime palette.

The supplier-independent `PartsCatalog` class accepts CSVs with mandatory
`part_id` and `color_id` columns. `color_id` always means **LDraw**, not Gobricks,
BrickLink or LEGO. Optional columns are `name`, `sku`, `unit_price`, `weight_kg`
and `max_quantity`. USD prices and kg weights are strings parsed as Decimal.
Absent `max_quantity` means unlimited supply. Limits are counted across all
placements, including aliases sharing one SKU.

```csv
part_id,color_id,name,sku,unit_price,weight_kg,max_quantity
3001,4,Brick 2 x 4,my-red-brick,0.15,0.00219,20
3001,0,Brick 2 x 4,my-black-brick,0.15,0.00218,10
```

A plain allowlist can omit price and weight, and still restrict Nova. Such a
list cannot produce a price quote until exact pricing/weight data is supplied.

## Cost estimates

Both `/getPrice` and `/estimatePrice` now use exact part/color prices from the
selected snapshot for every generation mode. `/getPrice` retains color in its
breakdown and uses actual supplier weights instead of the old generic weights.
The old flat ten-cent fallback and the old 20% estimate markup are removed.
Decimal arithmetic rounds only the final subtotal to cents.

Missing mappings, unavailable combinations and missing pricing information
return HTTP 422 rather than a partial or invented total; missing catalog files
return HTTP 503. Legacy models may therefore have no quote until repaired. The
returned amount is a supplier parts subtotal, excluding shipping, taxes, customer
discounts and quantity-specific promotions. It reflects the recorded snapshot
time, not a live checkout guarantee. The existing BrickBuilder checkout discount
and shipping formula remains in `orderCheckout.ts`/`createCheckoutSession.py` and
consumes this new subtotal; checkout policy should be reviewed separately if a
different retail margin or shipping policy is desired.

## Validation

Run `cd backend && .venv/bin/python -m pytest tests`, and `npm test` from the
repository root. Tests cover catalog integrity and refresh failures, exact
color/price/weight matching, generic allowlists and finite quantities, protected
catalog references, publication blocking, runtime capability negotiation, and
pricing failures without a guessed fallback.

The credential-free runtime smoke script is
`backend/tests/nova_parts_runtime_smoke.py`. Run it inside the prepared Nova
image, replacing `IMAGE` with the image tag exported by `backend/setup_nova.cjs`:

```sh
docker run --rm --network none \
  -e LDRAW_NOVA_AGENT_USER=agent -e PYTHONPATH=/app/web/backend \
  -e LITELLM_LOCAL_MODEL_COST_MAP=True \
  -v "$PWD/backend/tests/nova_parts_runtime_smoke.py:/tmp/parts-smoke.py:ro" \
  --entrypoint python3 IMAGE /tmp/parts-smoke.py
```

It exercises Nova's real MPD parser, inherited colors, tool dispatcher and
publication gate without making any LLM calls or accessing provider credentials.
