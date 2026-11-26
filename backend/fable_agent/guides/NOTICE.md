# Notice: building guides

- **What it is:** guides for a model-building agent, adapted from the agent guides of **ldraw-nova**
  ("Agent tooling for generative LEGO model building"): `docs/agent/visual-design.md`,
  `complex-models.md`, `vehicles.md`, `spaceships.md`, `technic.md`, `mechanisms.md`, `snapping.md`,
  `validation.md` and `instructions.md`.
- **Author:** Carlos Antelo. Project: ldraw-nova. Source: https://github.com/anteloc/ldraw-nova. The
  text was taken from the fork https://github.com/jjohnson5253/ldraw-nova at commit
  `d98e9fe6b82ea725322db0dbc74519159f204f5e`, which adds changes by Jake Johnson.
- **Licence:** Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0),
  https://creativecommons.org/licenses/by-sa/4.0/. The full text is in `LICENSE-CC-BY-SA-4.0.md`.
- **Changes:** yes. Each guide here is a shortened rewrite for agents that write build scripts:
  `design.md`, `vehicles.md`, `spacecraft.md` and `joints.md`. The first line of each file says
  which guides it draws on and what was changed. The toolkit's command-line workflow, its plans
  and contracts, and its reference-discovery guides are not carried over.
- **Licence of this folder:** the guides in this folder are licensed CC BY-SA 4.0. Nothing in this
  repository restricts reusing them under that licence.

| File | Draws on |
|---|---|
| `design.md` | `visual-design.md`, `complex-models.md` |
| `vehicles.md` | `vehicles.md` |
| `spacecraft.md` | `spaceships.md` |
| `joints.md` | `technic.md`, `mechanisms.md`, `snapping.md`, `validation.md`, `instructions.md` |
