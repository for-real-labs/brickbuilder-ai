# Notice: code copied from the ldraw-nova toolkit

The Python files and the `data/` folder here are a copy of part of **ldraw-nova**, "Agent tooling
for generative LEGO model building".

- Original project: https://github.com/anteloc/ldraw-nova, Copyright (c) 2026 Carlos Antelo and
  contributors.
- Copied from the fork https://github.com/jjohnson5253/ldraw-nova at commit
  `d98e9fe6b82ea725322db0dbc74519159f204f5e`, which adds changes by Jake Johnson (Technic
  connector registry, portable geometry fingerprints, seating diagnostics).
- Licence: GNU Affero General Public License, version 3 (AGPL-3.0). The full text is in
  `LICENSE-AGPL-3.0` at the root of this repository. The code comes with no warranty.

## What was copied and what was changed

Every file starts with a header naming its origin and a dated "Modified by BrickBuilder" line.

| File here | Toolkit file | Changes |
|---|---|---|
| `connection_adapter.py` | `ldraw_tools/connection_adapter.py` | None. |
| `technic.py` | `ldraw_tools/technic.py` | `definition()` also recognises a part redrawn by a later library release when its size and holes match `data/technic-sizes.json`. |
| `technic_review.py` | `ldraw_tools/technic_review.py` | `contract_check` and `review_structure` left out. |
| `common.py` | `ldraw_tools/common.py` | Reduced to `DATA`, `jsonable`, `issue`, `atomic_write`, `get_parts`; `get_parts` takes its paths as arguments. |
| `vehicle_review.py` | `ldraw_tools/vehicle_review.py` | The road profile, rewritten to work in any frame on plain measurements; see the file's header. |
| `data/technic-parts.json` | `ldraw_tools/data/technic-parts.json` | None. |
| `data/rectangular-parts.json` | `ldraw_tools/data/rectangular-parts.json` | None. |
| `data/technic-sizes.json` | (new) | Written by `fable_agent/technic_sizes.py`: each measured part's outline and holes. |

## What this means for this repository

These files run inside the BrickBuilder backend, so the backend as a whole is offered under
AGPL-3.0; the root `README.md` says which files carry which licence. They use the `pyldraw3`
library (GPL-3.0-or-later, https://github.com/hbmartin/pyldraw3), installed as a dependency and
not copied here.
