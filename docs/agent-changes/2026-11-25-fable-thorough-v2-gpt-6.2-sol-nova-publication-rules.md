# Fable Thorough v2 · GPT-6.2 Sol: held to Nova's publication rules, with instructions in five-piece steps

- **Date:** 2026-11-25
- **Agent:** Fable Thorough v2 · GPT-6.2 Sol (`fable-thorough-v2-gpt-6.2-sol`)
- **Pull request:** [#403](https://github.com/for-real-labs/brickbuilder-ai/pull/403)

## What changed

Thorough v2 is now held to what Nova requires before it publishes. The rules are Nova's own files
(`backend/nova-service/flatten.py`, `material_collision.py`, `material_surfaces.py`), loaded by
`fable_agent/nova_rules.py`, so a later fix to Nova's rules reaches this agent too.

- **Instructions in small connected steps.** A published model's instructions add at most five
  connected pieces per step, start with the pieces on the ground and go upward. No step asks for
  a piece before what holds it, and no piece is closed in before it is placed. A piece that hangs
  under its support is shown as built together with it. Before, there was one step per `step()`
  call in the script: the ten test buildings had 120 to 632 pieces in their largest step.
- **Solid plastic cannot be waived.** Two plain bricks, plates or tiles in the same place are an
  error at any rotation, and so is anything that cuts into a seat back, a dish rim, a curved tile
  or a side stud. `allow_overlap` no longer excuses these. Parts turned off the grid were not
  checked for overlap at all; plain ones now are.
- **Declared joints need evidence.** `connect()` was taken on trust. Now the two parts must touch,
  and a Technic pin or axle must lie in a hole of the other part.
- **One connected model.** Free-standing pieces were a warning and are now an error.
- **A rejected build is kept.** When no revision passes, the last build is saved with its failed
  checks, and the website offers it as an unverified draft, as it does for Nova.
- **3D by default.** The website adds the product's design default to the request: a photo is
  built as a 3D model, and a mosaic only when asked for. This applies to every Fable agent.
- **Axle wheels fixed.** The new joint rule found that the `truck`, `big`, `tall` and `balloon`
  wheels recorded their joints between parts that do not meet, and that a truck four studs wide
  got no axle. They now record brick to axle and axle to wheel, with an axle that reaches both
  rims, or a short axle through each brick when the body is too wide for one.
- The prompt grew by about 200 tokens: a section on what the report now requires.

**Update, 2026-11-26:** the rules were then copied into the Fable agents' own code
(`fable_agent/solids.py`, `material.py`, `sequence.py`) and are no longer loaded from
`backend/nova-service`, so the two can change apart. Building orders and collision results were
identical on 63 saved builds. [#404](https://github.com/for-real-labs/brickbuilder-ai/pull/404)

## Why

Over six weeks Nova gained checks for the ways it had published wrong builds and instructions:
steps with too many pieces, pieces attached to nothing built so far, parts trapped under a cover,
solid plastic intersecting, seat backs and dish rims clipping, joints that were not connected.
The v2 agents had none of the instruction checks and let a script waive any overlap: every one of
ten test buildings had waived 3 to 46.

## What stayed the same

- The method, rounds, tools, limits, helpers and automatic repair.
- The first-version agents (Fable, Fable Lean): their checks, prompts and instructions are as
  they were, except for the 3D default on the website.
- Nova itself. Its files are read, not changed.

## Results

- 54 builds published before this change were replayed through the new rules: 52 pass. The two
  that fail are both jeeps whose spare wheel was mounted on a pin that is not in a hole, which is
  the defect the rule is for.
- Every helper style passes on the real parts: 3,399 cases across 381 styles.
- Five new Pip builds on GPT-6.2 Sol, one run each:

| Build | AI cost | Rounds | Minutes | Parts | Instruction steps | Largest step |
|---|---|---|---|---|---|---|
| Pickup truck on a road | $0.05 | 3 | 1.3 | 176 | 54 | 5 |
| Furnished living room | $0.08 | 2 | 1.3 | 416 | 122 | 5 |
| Castle | $0.08 | 3 | 1.6 | 818 | 265 | 5 |
| Jeep with a spare tyre | $0.14 | 6 | 1.9 | 162 | 65 | 5 |
| Lake house | $0.18 | 6 | 2.7 | 766 | 210 | 5 |

  The average is $0.106, about what the same subjects cost before ($0.05 to $0.16). The new rules
  cost a round only in the lake house, where the report refused two pairs of solid plastic.

  These runs were made with Pip, which shares the checker. Thorough v2 itself was not run after this change.

## Not verified

- A signed-in build on the live site, and the draft download for a rejected build there.
- Clips, bars, tyres on rims and panes in frames: these joints are checked for touching only,
  because the parts library does not name those connectors. The report counts them.
- Nova's Technic connector fingerprints are in its private toolkit and are not used here.
- Balance, and whether a hand can reach a part.

## Where it lives

- `backend/fable_agent/assembly.py`, `material.py`, `solids.py`, `joints.py`, `sequence.py`
- `backend/fable_agent/checks.py` (the optional review), `kit.py` (`to_ldraw` with a plan),
  `tools.py` (`save_rejected`), `helpers/cars.py` (axle wheels)
- `backend/src/requests/fableToBricks.py` (draft upload, 3D default), `novaToBricks.py` (draft download)
- Tests: `backend/tests/test_fable_assembly.py`, `test_fable_agent_assist.py`, `test_fable_helpers_real.py`,
  `test_fable_web.py`
- Guide: [docs/fable-agent.md](../fable-agent.md#publication-rules-the-v2-methods)
