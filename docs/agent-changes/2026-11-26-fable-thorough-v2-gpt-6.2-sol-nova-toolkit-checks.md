# Fable Thorough v2 · GPT-6.2 Sol: Nova's connector data, Technic checks, vehicle review, guides and example retrieval

- **Date:** 2026-11-26
- **Agent:** Fable Thorough v2 · GPT-6.2 Sol (`fable-thorough-v2-gpt-6.2-sol`)
- **Pull request:** [#405](https://github.com/for-real-labs/brickbuilder-ai/pull/405)

## What changed

Thorough v2 shares its checker, repair, prompt additions and example library with the Pip agent, so it changes in
the same ways. The full account, with the table of every Nova change of the last six weeks, is in
[the Pip agent's document](2026-11-26-pip-agent-nova-toolkit-checks.md). In short:

- Joints are measured from connector data (the LDCad shadow library), with the earlier shape-based guesses as a
  fallback. A tyre on the wrong rim and a pane in the wrong frame are refused (`[fit]`).
- Technic pins and axles must be seated (`[technic]`), from Nova's registry of 51 measured parts.
- Wheels are reviewed as running gear, as warnings (`[vehicle]`).
- The building order will not close a part in between two others on one axle.
- Automatic repair swaps a part the catalog does not stock for the same mould under another number or a stocked
  part that measures the same.
- The prompt carries four short building guides.
- With examples on, the examples closest to the request are found by description with Jev instead of by category,
  from a library of 2,504 scripts converted from annotated official sets.

## Why

The same as for the Pip agent: the earlier comparison with Nova missed its toolkit.

## What stayed the same

- The agent id, its model, its tools and its turn limit.
- Nova and the first-version Fable methods.

## Results

Nothing was measured on Thorough v2. The checks were measured on Pip builds (see the Pip agent's document), and
the two share that code.

## Not verified

- Any Thorough v2 build after this change, and so its cost. Its prompt grew by the same 6,500 characters of
  guides, which it sends again every turn.
- Everything listed as not verified for the Pip agent.

## Where it lives

The same files as for the Pip agent; `backend/fable_agent/prompts.py` (`thorough_v2_system_prompt`) is where its
prompt takes the guides.
