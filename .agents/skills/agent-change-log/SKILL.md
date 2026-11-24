---
name: agent-change-log
description: Record every change to a BrickBuilder building agent (Nova, Astrology, Fable and their variants) as a dated document in docs/agent-changes, in the same pull request as the change. Use whenever you add an agent or agent option, or change an agent's prompt, tools, model, method, kit, checks, repair, limits or pricing.
---

# Agent change log

People who did not make a change need to learn later what an agent does differently and why, without reading the diff. Each change to a building agent therefore ships with one short document in `docs/agent-changes/`.

## When to write one

Write a document when a pull request changes how a building agent behaves or what it costs:

- a new agent or a new option in the Building agent dropdown;
- a change to an agent's prompt, tools, model, reasoning effort, method, step or spending limits;
- a change to what its scripts can call (the kit), to its checks or to automatic repair;
- a pricing or caching change that alters what a build costs.

Refactors, tests and comment edits that leave behavior and cost the same need no document. If one change affects several agents, write one document per agent, so each can be found by its agent.

## Where and how

1. Add `docs/agent-changes/YYYY-MM-DD-<agent-id>-<short-slug>.md`. Use the date the change is made and the agent's id as it appears in the dropdown code (`backend/src/utils/building_agents.py`), for example `2026-11-24-fable-lean-v2-gpt-6.2-sol-new-agent.md`. For a change to a whole family, use the family name (`fable-lean`, `nova`, `astrology`).
2. Start the document with a title that names the agent as users see it, then the change: `# Fable Lean v2 · GPT-6.2 Sol: new agent with ready-made trees and automatic repair`.
3. Fill in the sections below. Keep it to what a reader needs; link to code and longer docs instead of repeating them.
4. Add one line for it at the top of the list in `docs/agent-changes/README.md`.
5. Commit the document in the same pull request as the change.

## Sections

```markdown
# <Agent name as shown in the dropdown>: <what changed, in a few words>

- **Date:** YYYY-MM-DD
- **Agent:** <dropdown label> (`<agent id>`)
- **Pull request:** <link, once it exists>

## What changed

What the agent does differently now, in plain terms. One bullet per change.

## Why

The problem or measurement that led to it.

## What stayed the same

Agents and behavior deliberately left alone, so nobody has to guess.

## Results

What was measured: AI cost, model turns, minutes, parts, and how the result looked. Say how many
runs this rests on. If nothing was measured, say so.

## Not verified

What was not checked, for example a signed-in build on the live site.

## Where it lives

The files a reader would open first.
```

## Rules

- The repository is public. Leave out customer data, email addresses, keys, and customers' photos. Renders of test builds are fine.
- Report results as they are, including runs that failed and things that were not checked. One run is one run: say so instead of calling it an average.
- A changed agent keeps its id only when old builds should be treated as the same agent. When behavior changes enough that results should be compared, add a new id (a `v2`) and leave the old one as it was. Say which you did under "What stayed the same".
- Never edit an old document to describe a later change. Add a new one and link back.
