# Notice: LDCad shadow library (connector data)

- **What it is:** the *LDCad Shadow Library*, connector ("snap") descriptions for LEGO parts in
  the LDraw parts library: studs, clips and bars, pins and axles with their holes, hinge fingers,
  and the seats of tyres, panes and doors.
- **Authors:** the LDCad Shadow Library contributors. The library was started by Roland Melkert,
  the author of LDCad (https://www.melkert.net/LDCad). Each file names its contributors in its
  `0 !HISTORY` lines; `SOURCES.md` lists every file with them.
- **Source:** `data/offLibShadow/` of https://github.com/jjohnson5253/ldraw-nova at commit
  `d98e9fe6b82ea725322db0dbc74519159f204f5e`, a fork of https://github.com/anteloc/ldraw-nova.
- **Licence:** Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0),
  https://creativecommons.org/licenses/by-sa/4.0/. The full text is in
  `LICENSE-CC-BY-SA-4.0.md` in this folder.
- **Changes:** the files under `parts/` and `p/` are unchanged. `seats.json` is new: it was
  derived from them by `fable_agent/seats.py` and lists, for each pair of parts whose seat
  connectors fit, where the nested part sits in its host.
- **Licence of this folder:** everything in this folder, including `seats.json`, is licensed
  CC BY-SA 4.0. Nothing in this repository restricts reusing it under that licence.

BrickBuilder checks customers' models against this data. The models are not made from it.
