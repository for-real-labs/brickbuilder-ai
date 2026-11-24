# Fable Lean v2 · GPT-6.2 Sol: new agent with ready-made trees and automatic repair

- **Date:** 2026-11-24
- **Agent:** Fable Lean v2 · GPT-6.2 Sol (`fable-lean-v2-gpt-6.2-sol`)
- **Pull request:** [#395](https://github.com/for-real-labs/brickbuilder-ai/pull/395)

## What changed

A new Building agent option. It runs the lean method (a few short, stateless rounds) on
`gpt-6.2-sol`, as Fable Lean · GPT-6.2 Sol does, with two additions:

- **Ready-made trees.** The build script can call `tree(x, y, z, height, width, style, leaves,
  accent, trunk)`. It places a whole tree, pine or bush made of layers that cannot overlap or come
  loose, in the stocked color closest to the one asked for. The prompt tells the model to use it
  for every ordinary tree.
- **Automatic repair.** Before a build is checked, a plain brick, plate or tile that runs into
  another part is cut back to the cells that are free, and a part asked for in a color it is not
  sold in is placed in the closest color it is sold in. The build report says what was repaired.
  Shaped parts are never cut, nothing is moved, and unattached parts are left to the model. The
  repaired build still goes through every check.

## Why

A study of the 42 draft revisions that had errors, across seven lake house builds, found:

- about half were the model fighting tree canopies it had built from loose parts;
- two thirds of the 983 overlapping pairs involved a plain part that could simply be cut back;
- one build spent a whole round on a single glass door in a color it is not sold in.

None of these needs the model's judgment, and each cost a paid round.

## What stayed the same

- Fable Lean · GPT-6.2 Sol (`fable-lean-gpt-6.2-sol`) and every other existing option: same
  prompt, same tools, no repair. `tree()` exists in the kit for every script, but only the v2
  prompts mention it.
- The lean method's rounds, tools, limits (medium effort, 8 rounds, $2) and model.
- Access (the Astrology allowlist), billing and script isolation.

## Results

One run each on the lake house photo with the prompt "Build my lake house from this photo."

| | AI cost | Rounds | Minutes | Parts | Parts cost |
|---|---|---|---|---|---|
| Fable Lean v2 · GPT-6.2 Sol | $0.18 | 5 | 3 | 988 | $146 |
| Fable Lean · GPT-6.2 Sol | $0.22 | 5 | 4 | 1,073 | $147 |

The v2 build passed its checks. It planted every tree and bush with `tree()` (8 calls), and the
repair cut back 4 plain parts in the published revision. It still took 5 rounds: three drafts had
errors the repair does not touch, among them a sideways-built part. So the saving on this run is
smaller rounds, not fewer rounds. The trees are fuller than the first version's, and the lawn is
green where the first version's run chose olive, though ground color varies from run to run.

Single runs show cost and character, not an average.

## Not verified

- A signed-in build with this option on the live site.
- Subjects other than the lake house.

## Where it lives

- `backend/fable_agent/trees.py`: the tree builder.
- `backend/fable_agent/repair.py`: the repair.
- `backend/fable_agent/prompts.py`: `ASSISTED`, the text both v2 prompts add.
- `backend/fable_agent/app.py`: the `lean-v2` method.
- `backend/src/utils/building_agents.py`: the option.
- [docs/fable-agent.md](../fable-agent.md): the methods in full.
