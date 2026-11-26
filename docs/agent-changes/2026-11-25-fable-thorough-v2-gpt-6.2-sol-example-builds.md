# Fable Thorough v2 · GPT-6.2 Sol: optional example builds, chosen by category

- **Date:** 2026-11-25
- **Agent:** Fable Thorough v2 · GPT-6.2 Sol (`fable-thorough-v2-gpt-6.2-sol`)
- **Pull request:** PRLINK

## What changed

- A new option, **off by default**: Thorough v2 can read finished build scripts of the request's kind
  before it starts. It is a checkbox in Generation settings ("Show example builds first"),
  `use_examples` on the request and `--examples` on the command line.
- When it is on, the model is first asked which kind of subject the request is closest to (cars,
  aircraft, boats, spacecraft, houses, buildings, castles, animals, characters, flat pictures, or
  none). Every example of that kind is then added to the end of its prompt, up to 30,000
  characters (about 8,500 tokens). Today every category fits whole.
- There are 41 examples in 10 categories: 13 written for BrickBuilder with the helpers, and 28
  official LEGO sets converted from the LDraw Official Model Repository to plain `place` calls in
  building order. Every one passes the checks a Pip build must pass.

## Why

Requested, to give the model real sets to look at. Two earlier tests with one written example
per build (36 car builds and 10 buildings) had shown no saving, so the option is off by default
and the choice of category is left to the model.

## What stayed the same

- A build with the option off: its prompt, rounds and cost are unchanged.
- The first-version agents have no examples, whatever a request sends.
- An existing session keeps the prompt it started with when it is changed later.

## Results

Pip on GPT-6.2 Sol, the same five requests with the option off and on, one run each:

| Build | Off: AI cost, rounds | On: AI cost, rounds | Category chosen |
|---|---|---|---|
| Pickup truck on a road | $0.05, 3 | $0.09, 2 | cars |
| Furnished living room | $0.08, 2 | $0.14, 3 | houses |
| Castle | $0.08, 3 | $0.16, 5 | castles |
| Jeep with a spare tyre | $0.14, 6 | $0.14, 6 | cars |
| Lake house | $0.18, 6 | $0.06, 3 | houses |
| **Average** | **$0.106, 4.0** | **$0.119, 3.8** | |

- All ten published. The difference is within what one run varies by; it does not show that
  examples help or hurt.
- The choice of category cost under a tenth of a cent each time and fitted the request in four
  of five builds; a living room was sent to `houses`, where `none` would have been as good.
- Examples add about 5,500 tokens to the prompt for cars or houses. That is about 1.5 cents on a
  first round that misses the provider's cache and about 0.05 cents on later rounds.
- Of 1,829 model files of official sets, 28 pass intact. A set is kept only if at least 80% of it
  survives without the parts the checks cannot join (minifigures, clips, hinges, wheels on pins).
  No set with wheels passes, so the car examples are all written ones.

  These runs were made with Pip. Thorough v2 with examples was not run.

## Not verified

- A signed-in build on the live site with the checkbox on, and how the checkbox looks there on a
  phone and a desktop: it is shown only to allowlisted accounts, so it was checked by tests, not
  by eye.
- Whether examples improve how a model looks. Nobody has compared the pictures side by side for
  these ten.
- Pip with examples on models other than GPT-6.2 Sol.

## Where it lives

- `backend/fable_agent/examples/`: `__init__.py` (categories, budget, prompt section),
  `chooser.py` (the model's choice), `importer.py` (set conversion), `library/`, `SOURCES.md`
- `backend/scripts/build_fable_examples.py` rebuilds the official-set examples from downloaded files
- `backend/fable_agent/app.py` (`Options.examples`), `backend/src/requests/fableToBricks.py`,
  `backend/src/utils/building_agents.py` (`EXAMPLE_AGENTS`)
- `frontend/src/pages/LandingPage.tsx` (the checkbox), `frontend/src/services/novaToBricksApi.ts`
- Tests: `backend/tests/test_fable_examples.py`, `test_fable_web.py`;
  `frontend/tests/building-agents.test.ts`, `landing-page.test.tsx`
- Guide: [docs/fable-agent.md](../fable-agent.md#example-builds)
