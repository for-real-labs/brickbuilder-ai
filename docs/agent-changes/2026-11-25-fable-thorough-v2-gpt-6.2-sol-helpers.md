# Fable Thorough v2 · GPT-6.2 Sol: 16 helpers with 310 styles

- **Date:** 2026-11-25
- **Agent:** Fable Thorough v2 · GPT-6.2 Sol (`fable-thorough-v2-gpt-6.2-sol`)
- **Pull request:** [#401](https://github.com/for-real-labs/brickbuilder-ai/pull/401)

## What changed

Its build scripts can call the same 16 helpers the Pip agent gets, with 310 styles between them,
where before it had `tree` with 3 styles. The prompt's helper section is generated from the helper
registry. The change is described in full in
[Pip agent: 16 helpers with 310 styles](2026-11-25-pip-agent-helpers.md).

## Why

Both v2 agents share one helper list by design, so that a helper is written and tested once.

## What stayed the same

Its method, tools, limits and automatic repair. What a helper cannot make is still built by hand.

## Results

None for this agent. Every test build of the helpers was made with the Pip agent.

## Not verified

- Any build with this agent since helpers were added. Its prompt is about 3,500 tokens longer per
  turn, and a thorough build takes about 15 turns, so its cost per build may have risen by a few
  cents; that has not been measured.

## Where it lives

- `backend/fable_agent/helpers/` and `assisted()` in `backend/fable_agent/prompts.py`.
