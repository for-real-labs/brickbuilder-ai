# Pip agent: the default All parts agent for every account, with example builds on

- **Date:** 2026-11-27
- **Agent:** Pip agent (`pip-agent`)
- **Pull request:** to follow

## What changed

- Every account's All parts builds now use the Pip agent on its default model (GPT-6.2 Sol). Accounts off the
  allowlist see no agent or model choice; the backend refuses any other agent or model for them.
- Accounts on the allowlist still choose any agent and model; Pip is preselected.
- Example builds are on by default. An account on the allowlist can turn them off in Generation settings.
- A build from a parts inventory goes to Nova, because Pip builds from the catalog only.
- Running the site locally, Nova stays the default: the local ChatGPT and Claude account connections are Nova's.

## Why

Pip costs about $0.10 to $0.20 of AI per build where Nova costs dollars, and now carries Nova's checks.

## What stayed the same

- Nova is still offered to allowlisted accounts and still builds edits of models it made.
- Edits are built by the agent that made the original model.
- Agent ids are unchanged.

## Results

Not measured as a change: the cost of examples on was measured on 2026-11-26 ($0.133 average per build against
$0.112 with them off, 40 builds each), before the library grew to 16,850 examples.

## Not verified

- A signed-in build on the live site.
- Load: Pip builds run in the API service, three at a time with six waiting (`FABLE_MAX_CONCURRENT_BUILDS`, default
  3). With every account on Pip, a busy hour can return "Fable is busy right now".
- Accounts that pay with their own AI keys (personal billing) cannot use them with Pip.

## Where it lives

- `frontend/src/pages/LandingPage.tsx`, `frontend/src/utils/buildingAgents.ts` (`DEFAULT_BUILDING_AGENT`)
- `backend/src/utils/building_agents.py` (`open_to_everyone`), `backend/src/api.py`, `backend/src/requests/novaToBricks.py`,
  `backend/src/requests/fableToBricks.py`
- Tests: `frontend/tests/landing-page.test.tsx`, `backend/tests/test_fable_web.py`
