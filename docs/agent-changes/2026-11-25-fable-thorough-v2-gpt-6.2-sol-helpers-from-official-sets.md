# Fable Thorough v2 · GPT-6.2 Sol: helpers checked against official sets, with vehicle bases and furniture

- **Date:** 2026-11-25
- **Agent:** Fable Thorough v2 · GPT-6.2 Sol (`fable-thorough-v2-gpt-6.2-sol`)
- **Pull request:** PR_LINK

## What changed

- Two new helpers. `chassis()` builds the rolling base of a vehicle, a floor with every axle,
  wheel and tyre joined under it, in 23 styles from a kart to a three-axle lorry. `furniture()`
  builds 33 pieces: tables, sofas, beds, cupboards with drawers, kitchen and bathroom fittings,
  crates and barrels. There are now 18 helpers with 381 styles (was 16 with 310).
- New styles in five helpers: `window` gets six sheets of frameless glass, `wheels` three large
  tyres and trolley wheels, `railing` a low panel and a glass one, `stairs` a ladder, `plant` two
  flower stems.
- Three corrections to `wheels()`, found by comparing it with official sets:
  the four small styles put their holder half a stud off the grid; the `truck` style put both
  wheels three studs to one side of the body; the wide classic tyre reached 2.75 plates below
  its holder while its note said 2, so it sank into the ground.
- A vehicle built with `wheels()` or `chassis()` on a road or baseplate is now joined to it. Before,
  the checks reported it as floating and the model spent a round on it.
- The prompt's helper section grew from about 3,500 to about 4,500 tokens per round, most of it
  cached after the first round.

## Why

The first helpers came from customers' models. To check them and find what was missing we read
every model in the LDraw.org Official Model Repository (1,829 model files of 1,740 official sets)
and Rebrickable's published part lists. Official sets are where a joint is certain to be right.
They confirmed the door, glass and small-wheel joints, showed the three wheel errors above, and
showed how sets give tyres room under a four-wide car: a plate and an arched mudguard over each
axle. Parts many sets use and no helper did became the new styles. The evidence and the sources
that could not be used (BrickLink, Rebrickable fan models) are in
[docs/fable-helpers.md](../fable-helpers.md).

## What stayed the same

- Thorough v2's method, tools, part measurements, batched edits, limits and its automatic repair.
- Every existing style keeps its name and arguments. The three wheel corrections move parts of
  models that used those styles (half a stud for the small holders, to the correct side for
  `truck`); nothing else an existing style builds has changed.
- What no style can make is still built by hand.
- Every agent that is not a v2 agent. Their prompts do not mention helpers.

## Results

No Thorough v2 build was run with these helpers. The two test builds were made with the Pip agent, which
shares the helpers: a pickup truck ($0.09, 3 rounds) and a furnished living room ($0.14, 5 rounds), both
published. See [the Pip entry](2026-11-25-pip-agent-helpers-from-official-sets.md).

All 381 styles pass the real-parts test (every style at several sizes and facings, 492 tests) and
the stand-in tests that run in CI.

## Not verified

- A signed-in build on the live site.
- Any Thorough v2 build with these helpers, including its cost.

## Where it lives

- `backend/fable_agent/helpers/vehicles.py` (`chassis`), `furniture.py` (`furniture`), and the
  style tables in `cars.py`, `windows.py`, `railings.py`, `stairs.py`, `props.py`
- `backend/fable_agent/kit.py`: `Kit.stand`, which joins tyres to the road under them
- Tests: `backend/tests/test_fable_helpers.py`, `backend/tests/test_fable_helpers_real.py`
- Evidence: [docs/fable-helpers.md](../fable-helpers.md)
