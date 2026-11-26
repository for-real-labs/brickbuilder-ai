# Pip agent: pins, clips, hinges and wheels are measured, and examples have no size cap

- **Date:** 2026-11-26
- **Agent:** Pip agent (`pip-agent`), on every model it offers
- **Pull request:** [#405](https://github.com/for-real-labs/brickbuilder-ai/pull/405)

## What changed

- **Joints are measured.** The checks now find a joint themselves when a peg of one part sits in a
  hole of another: a Technic pin or axle in a hole, a bar in a clip or a hollow stud, a hinge pin
  in its base, a wheel on its pin or axle, a tyre on its rim. Such parts count as attached without
  `connect()`, and the space they share is no longer reported as an overlap, so they need no
  `allow_overlap` either. Before, a script had to declare each of these and the checks took its
  word. The prompt says so in about 80 more tokens.
- It works from the parts library, which draws a peg as a cylinder seen from outside and a hole as
  one seen from inside. No list of part numbers is kept. Axles are matched by the library's own
  names; wheels and tyres by name and by how they sit, since many are drawn without cylinders.
- A declared joint that the checks can measure is now reported as measured, not only as touching.
- **Example builds: no cap on a set's size, and more of them.** The limit of 200 pieces is gone:
  a set may be any size a build may be. With the joints above and with old part numbers matched to
  the parts now stocked, the library went from 28 official sets to 62 (75 examples with the
  written ones). The largest is Tower Bridge at 3,462 pieces.
- The prompt budget for examples went from 30,000 to 120,000 characters (about 34,000 tokens), so
  that larger sets can be shown. Every category fits whole except buildings, where 16 of 22 fit.

## Why

Asked for: official sets should not be left out for their size, and the checks should understand
clips, hinges and pins instead of dropping the sets that use them. Measuring those joints also
means a Pip build no longer depends on the model declaring them correctly.

## What stayed the same

- Studs, the refusal of solid plastic in the same place, the one-model rule and the five-piece
  instruction steps.
- Joints the library does not draw as a peg in a hole are still declared and checked for touching
  only: a pane in its frame, a door on its hinges, a trolley wheel in its holder.
- The first-version agents measure nothing and are unchanged.
- Example builds are still off unless turned on.

## Results

- The wheel helper declares 332 joints across its styles and widths; 328 are now measured on the
  real parts (all but the trolley wheel), and nothing is joined that the helper did not join.
- On 32 builds published before this change, every measured joint was a real one, and the only
  build that fails is the jeep whose spare wheel was mounted beside its hole.
- Official sets that pass as examples: 62 of 1,830 files, up from 28. Removing the size cap alone
  added 10. Among sets of up to 400 pieces, the two large remaining causes are about equal: over
  20% of the pieces are not in the catalog, or over 20% are lost to a joint that is still not
  measured or to coarse part shapes that overlap. No official car set passes: most use wheels the
  catalog does not stock.
- Five Pip builds on GPT-6.2 Sol with examples off, one run each:

| Build | AI cost | Rounds | Minutes | Joints measured |
|---|---|---|---|---|
| Pickup truck on a road | $0.08 | 4 | 1.6 | 10 |
| Lake house | $0.14 | 5 | 2.9 | 31 |
| Furnished living room | $0.14 | 7 | 2.0 | 15 |
| Castle | $0.15 | 4 | 2.8 | 39 |
| Jeep with a spare tyre | $0.19 | 6 | 2.8 | 12 |

  The average is $0.139, against $0.106 for the same five the day before. No round was spent on
  a joint error; the extra rounds were ordinary overlaps and the model choosing to keep improving.
  With one run each this does not show that builds became dearer, and it does not show they did not.

## Not verified

- A build with examples on after this change, and so what the larger budget really costs. The
  estimate is up to 9 cents more on a first round that misses the provider's cache.
- A signed-in build on the live site.
- Whether a measured joint is strong enough for what hangs on it: the check says the parts line
  up, nothing more.

## Where it lives

- `backend/fable_agent/fits.py` (the joints), `ldraw.py` (`cylinders`, and inside-out surfaces in `_parse`)
- `backend/fable_agent/checks.py`, `assembly.py`, `joints.py`, `sequence.py` (where the joints are used)
- `backend/fable_agent/examples/importer.py` (`StockedParts`, no size limit), `__init__.py` (`PROMPT_BUDGET`)
- Tests: `backend/tests/test_fable_assembly.py`, `test_fable_examples.py`
- Guide: [docs/fable-agent.md](../fable-agent.md#publication-rules-the-v2-methods)
