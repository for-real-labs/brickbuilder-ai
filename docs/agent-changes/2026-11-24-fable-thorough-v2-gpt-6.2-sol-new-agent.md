# Fable Thorough v2 · GPT-6.2 Sol: new agent that takes fewer turns

- **Date:** 2026-11-24
- **Agent:** Fable Thorough v2 · GPT-6.2 Sol (`fable-thorough-v2-gpt-6.2-sol`)
- **Pull request:** [#395](https://github.com/for-real-labs/brickbuilder-ai/pull/395)

## What changed

A new Building agent option. It runs the thorough method (one growing conversation with every
tool) on `gpt-6.2-sol`, as Fable · GPT-6.2 Sol does, with these additions:

- **Part measurements up front.** The catalog in its prompt gives each listed part's size, which
  way its low side faces and whether it is smooth on top, as the lean method's prompt does.
- **Batched look-ups.** `inspect_part` takes up to 12 parts in one call.
- **Batched edits.** `edit_script` takes a list of replacements and rebuilds once. All of them
  apply, or none do.
- **A section on working economically.** The prompt says each turn re-sends the conversation, and
  that calls in one turn run in order, so an edit and the render of its result can go together.
- **Ready-made trees.** The build script can call `tree()` for a whole tree, pine or bush made of
  layers that cannot overlap or come loose.
- **Automatic repair.** Before a build is checked, a plain brick, plate or tile that runs into
  another part is cut back to its free cells, and a part asked for in a color it is not sold in is
  placed in the closest color it is sold in. Shaped parts are never cut, nothing is moved, and the
  repaired build still goes through every check.
- **Prompt caching.** It uses the caching fix all OpenAI runs have had since 2026-11-22: the
  system prompt is sent where `gpt-6.2` models cache it.

## Why

The first thorough run on `gpt-6.2-sol` took 39 model turns and 76 actions for one lake house, and
43 of those actions were part look-ups. It made 26 single edits, each a turn of its own. Its cost
is driven by the number of turns: each one re-reads the conversation and adds to it.

## What stayed the same

- Fable · GPT-6.2 Sol (`fable-gpt-6.2-sol`) and every other existing option: same prompt and
  tools, checked byte for byte against a saved run, and no repair.
- The caching fix is not new to v2 and was not taken out of the first version: it has been live
  for every OpenAI option since they were added. The first version's published figure of $1.20
  comes from a run made before that fix.
- The thorough method's limits (high effort, 60 turns, $8), its tool names and its publish gate.
- Access (the Astrology allowlist), billing and script isolation.

## Results

One run each on the lake house photo with the prompt "Build my lake house from this photo."

| | AI cost | Model turns | Actions | Script revisions | Minutes | Parts | Parts cost |
|---|---|---|---|---|---|---|---|
| Fable Thorough v2 · GPT-6.2 Sol | $0.46 | 15 | 23 | 4 | 9 | 1,282 | $164 |
| Thorough v2 without trees and repair (not shipped) | $0.51 | 16 | 31 | 6 | 8 | 999 | $130 |
| Fable · GPT-6.2 Sol, measured before the caching fix | $1.20 | 39 | 76 | 27 | 12 | 1,161 | $177 |

- The v2 build passed its checks, planted its trees with `tree()` (6 calls), and the repair cut
  back 2 plain parts in the published revision.
- With the caching fix the first version is estimated at about $0.60, from the same run's token
  counts. It has not been re-run, so the like-for-like saving is roughly a quarter, not the
  60% the table suggests.
- Turns fell by about 60%, but cost fell less, because each remaining turn writes more.
- It still made 12 look-up calls (searches and inspections), mostly for parts the catalog sheet
  does not list.

Single runs show cost and character, not an average.

## Not verified

- A signed-in build with this option on the live site.
- Subjects other than the lake house.
- A follow-up edit on the live site with this option; the edit path is covered by unit tests only.

## Where it lives

- `backend/fable_agent/prompts.py`: `thorough_v2_system_prompt`, `THOROUGH_V2_ECONOMY`, `ASSISTED`.
- `backend/fable_agent/tools.py`: `THOROUGH_V2_TOOLS`, `apply_edits`.
- `backend/fable_agent/trees.py` and `backend/fable_agent/repair.py`.
- `backend/fable_agent/app.py`: the `thorough-v2` method.
- `backend/src/utils/building_agents.py`: the option.
- [docs/fable-agent.md](../fable-agent.md): the methods in full.
