# Pip agent: Nova's connector data, Technic checks, vehicle review, guides and example retrieval

- **Date:** 2026-11-26
- **Agent:** Pip agent (`pip-agent`)
- **Pull request:** [#405](https://github.com/for-real-labs/brickbuilder-ai/pull/405)

## What changed

- **Joints come from connector data.** Pip has its own copy of the LDCad shadow library (connectors of about
  4,600 parts) and reads it with `pyldraw3`. A pane or door in its frame, a tyre on its rim, hinge halves, a bar in
  a clip and a pin in a hole count as attached without `connect()`. The shape-based guesses of the previous change
  stay as a fallback for parts the data does not describe.
- **A part that does not fit is refused (`[fit]`).** A tyre on a rim that is not the size of any rim it is sold on,
  and a pane in a frame it was not made for, are errors however well they are centred. `inset()` now puts a nested
  part on the seat the data gives instead of in the middle of the frame's outline.
- **Technic seating (`[technic]`).** Nova's registry of 51 hand-measured Technic parts is copied with its review:
  a pin must be centred in its holes, an axle must reach through its hole (the message says how long it must be),
  and two parts may not take one hole. An axle with no stop at both ends and a single-pin pivot are warnings. A
  wheel or gear the registry has not measured is joined to a measured axle that passes through its hole.
- **Vehicles are reviewed (`[vehicle]`).** The kind of vehicle is read from the request's words. For a car, truck
  or other wheeled vehicle, a tyre off the ground the others stand on and bodywork below the tyres are errors; for
  anything else, warnings. A part inside the space a tyre turns in (measured on its real surface, not its outline)
  and an axle that is not a mirrored pair are warnings, and so is a plane or boat that is not a mirror image left
  to right. The toolkit's motorcycle, boat and aircraft profiles, which look for the parts of its own example
  plans, are replaced by that symmetry check. These vehicle rules were added after the measurement below.
- **Building order knows axles.** A part is slid onto an axle before parts sit on both sides of its place. This
  rule of Nova's instruction planner was missing from the earlier port.
- **Automatic repair swaps unstocked parts.** A part the catalog stocks in no color is replaced by the same mould
  under another number, or by a stocked part that measures the same (outline, height, studs, surfaces), and then
  given the closest stocked color. A part with no safe stand-in stays a `[palette]` error. The report lists each swap.
- **Four building guides in the prompt**: design, vehicles, spacecraft and joints that are not studs, adapted from
  the Nova toolkit's agent guides (about 6,500 characters).
- **Examples are found by description, not by category.** The example library is rebuilt from the toolkit's
  annotated official sets and example atlases: 16,850 scripts, each a whole model or one described submodel. With
  examples on, the request is ranked against their descriptions by Jev (keyword shortlist, then semantic rerank)
  and the best five that fit are shown, at most two per set. When Jev is unavailable the keyword ranking is used and
  the build's record says so. Examples keep the parts their set uses, stocked or not; the prompt says the build
  itself may use catalog parts only. The 13 hand-written examples and the category chooser are gone. Examples
  remain an option in Generation settings, off by default.
- **Licences.** Code copied from the toolkit is in `backend/fable_agent/toolkit/` under AGPL-3.0; the connector
  data, the examples and the guides are in their own folders under CC BY-SA 4.0, each with the licence text and a
  notice. The backend as a whole is now offered under AGPL-3.0; the README says which files carry which licence.

## Why

The comparison of 25 November looked only at `backend/nova-service` and missed the toolkit, where most of Nova's
checks live. Pip's joints were then guessed from part shapes although Nova had real connector data. This change
redoes the comparison against the toolkit and brings the rest across.

## Every Nova change of the last six weeks, and where Pip stands

Listed from both places Nova's checks live: this repository (`backend/nova-service`, `backend/src`,
10 October to 26 November 2026) and the toolkit and web wrapper it pins (`ldraw-nova`,
`ldraw-nova-docker`). Changes to billing, sign-in, the pet, checkout and Nova's hosting are left out:
they are not about what a build is checked for.

### Toolkit (`jjohnson5253/ldraw-nova`, up to the pinned `d98e9fe6`)

| Commit | Change | In Pip |
|---|---|---|
| `23c5a81f` | Shallow blind wing sockets count as stud receptacles | **In Pip.** Pip measures studs by shape, not by connector kind, so it never had the fault; a test now stacks the same wing plates on a turned single stud. The adapter itself is copied (`toolkit/connection_adapter.py`). |
| `ef2d93fa` | Navigation lights attach through their shallow sockets (a test of the above) | **In Pip**, by the same stud measurement. |
| `d20fcdfe` | Card caddy: axle, gear hub, pin and hinge connections (registry data for 15 parts) | **In Pip now.** The registry is copied whole (`toolkit/data/technic-parts.json`, 51 parts). Its one-line change to reference search does not apply: Pip has no structural-reference search. |
| `08ef0ced` | Connector fingerprints portable across platforms | **In Pip now** (`toolkit/technic.py`); a test checks the measured parts are recognised. |
| `e1f7d53e` | Crawler bearings, sprocket hubs, boom pin seats (rolled bores; a seated grip may end flush with the next beam) | **In Pip now** (`toolkit/technic.py`, `toolkit/technic_review.py`). |
| `dad7154f` | Guidance: prove a mechanism's mounts before adding bodywork | **In Pip now**, as text in `guides/joints.md`. Pip has no separate "check this sub-assembly" tool and needs none: its report runs the same seating checks on the whole build every round. |
| `52395486` | Excavator panel seats; an axle too short for its hole is reported with the length it needs | **In Pip now**; the needed length is in the `[technic]` message, with a test. |
| `d98e9fe6` | Stable fingerprints for transformed sprocket curves | **In Pip now** (`toolkit/technic.py`). |

### Web wrapper (`jjohnson5253/ldraw-nova-docker`, up to the pinned `767a2f08`)

| Commit | Change | In Pip |
|---|---|---|
| `b67ee2bf` | Revert fast previews and Verify Build | **Not applicable.** It restores Nova's own chat flow. |
| `767a2f08` | Optional maximum number of physical parts per chat | **In Pip already**: the request's piece limit is a `[limit]` error in every report. |

### This repository

| Commit | Change | In Pip |
|---|---|---|
| `b1d7f3c4` (#232) | Instruction steps of at most five connected pieces | **In Pip** (`sequence.py`, since #403). |
| `12016c2d` (#233) | Axle mounts placed before their upper covers | **In Pip** (`sequence.py`: nothing is closed in before it is placed). |
| `f6093821` (#238) | Publication gated on connected instruction placement; pin moved to `23c5a81f`, `ef2d93fa` | **In Pip** (one connected model and a building order, since #403); the toolkit side is in the table above. |
| `88b85ee6` (#303) | Pieces that hang under their support are grouped in one step | **In Pip** (`sequence.py`). |
| `45b89684` | 3D by default unless a flat build is asked for | **In Pip** (since #403). |
| `c7778936` (#330) | Baseplate foundations are seated first | **In Pip** (`sequence.py`). |
| `adddba91` | Publication blocked on solid part collisions and validation errors | **In Pip** (`solids.py`, `material.py`, since #403 and #404). |
| `a96b1844` | Instruction imports kept compatible; overlap publication smoke test | **Not applicable**: packaging of Nova's service. |
| `fc111d1a` | Six-decimal rotation rounding allowed in the material check | **In Pip** (`solids.ROTATION_ROUNDING`). |
| `1279a774` | Generation parts limits; pin moved to `767a2f08` | **In Pip** (`max_parts`, the `[limit]` error). |
| `23e59927`, `867ae230`, `2abb762f` | Piece budgets read from the prompt and enforced | **In Pip**: `fableToBricks.py` applies the same `tighter_parts_limit`. |
| `c3536bb7` | Rejected drafts kept; caddy Technic connections (pin moved to `d20fcdfe`) | **In Pip**: the draft download since #403; the Technic side now. |
| `10af6bb9` | Portable Technic fingerprints (pin moved to `08ef0ced`, nothing else) | **In Pip now.** |
| `0c809432` (#363) | Mechanical subassemblies checked while building (pin moved to `d98e9fe6`); the instruction planner counts measured axle joints and will not close a part in between two others on one axle | **In Pip now.** The axle rule was missing from the earlier port and is added to `sequence.py` with a test. The `check_assembly` tool is not needed (see `dad7154f`). |
| `53850184` (#375) | Seat backs and dish rims block publication when cut into | **In Pip** (`solids.EXPOSED_PARTS`). |
| `931e8425` (#341), `958849b9` | Designing from existing parts and sets; finite inventories | **In Pip** as far as checks go: a quantity limit is a `[quantity]` error. The website's inventory mode is offered for Nova and Basic bricks, not for Pip (listed under "Not done yet" in the Fable guide). |
| `138f094f`, `826838d6` | Build clarifications and saved limits carried into generation and edits | **Not applicable**: the request layer, shared by all agents. |
| `08ee5202`, `ca5d209d`, `e64119a7`, `0fa93081`, `622480ba` | Heartbeats, orphaned processes, runtime archive, fast mode | **Not applicable**: how Nova's service runs. |

**Not brought over from the toolkit, and why**

- `vehicle_review.py`'s motorcycle, watercraft and aircraft profiles look for the named parts of the toolkit's own
  example plans. Pip's builds are not made from those plans. The road profile is in Pip, rewritten to work in any
  frame, and reports warnings, since a build is not told to be a vehicle.
- The wheel-space rule of the road profile treats a tyre as a full cylinder and flagged Pip's own wheel helper. Pip's
  solid-plastic check already measures the tyre's real surface, so the rule is copied but not applied.
- `collision.py`, `validation.py`, `geometry.py`, `connectivity.py`, `architecture.py`, `builder.py`, `manuals.py`
  and the catalog modules serve Nova's MPD files, plans and command line. Pip has its own script kit, overlap and
  solid-plastic checks, and instruction planner.
- Structure contracts (`required_joints`, `require_rigid`) need the script to declare which joints matter. Pip
  reports the same seating errors without them, and the two structural findings that need no contract (axle
  retention, a single-pin pivot) as warnings.

## What stayed the same

- Nova is untouched. Pip imports nothing from the Nova service or its toolkit and reads none of its files; a test
  fails if that changes.
- The first-version Fable methods (Fable, Fable Lean) are not held to any of this.
- The agent id is unchanged: these are stricter checks on the same agent, like the two changes before it.
- Solid plastic, declared joints, one connected model, five-piece steps and the rejected-draft download work as
  before.

## Results

Pip on GPT-6.2 Sol, five prompts (pickup, lake house, living room, castle, jeep), eight runs of each per
condition, four builds at a time with the conditions interleaved, on the current LDraw parts library. 136 builds
and one trial build; total AI spend $15.77 of the $20 allowed.

| Condition | Builds | Published | AI cost, average (median) | Rounds | Minutes, average (median) |
|---|---|---|---|---|---|
| `main` before this change (`f5a61ec8`) | 40 | 40 | $0.100 ($0.090) | 4.53 | 2.43 (2.22) |
| This change, examples off | 40 | 39 | $0.112 ($0.089) | 4.60 | 2.88 (2.92) |
| This change, examples on | 40 | 36 | $0.133 ($0.113) | 4.92 | 3.16 (2.95) |

One build's cost varies by about $0.05 (standard deviation) and its time by about a minute, so an average of 40
is known to about $0.008 and 0.16 minutes.

- **Cost, examples off: no change that can be told from the spread.** The average is $0.012 higher (about one
  standard error) and the median is the same. Four of the five prompts cost the same as before. The jeep did get
  dearer, $0.149 to $0.192 over eight runs each, which is more than the spread.
- **Time, examples off: about 0.45 minutes longer (19%)**, roughly two standard errors, so probably real. The
  connector check adds 1 to 5 seconds to a build's first check and under a second to each later one. The rest is
  the model: with the longer prompt it writes 11% more per round (1,107 to 1,225 output tokens), and the jeep takes
  more rounds.
- **The prompt** grew from 44,332 to 52,114 characters (the guides are 6,485 of that). A first round costs $0.032
  instead of $0.030.
- **Examples on costs a third more than `main`** ($0.033, about three standard errors) and publishes less often
  (36 of 40). It did not save rounds on any prompt. The Jev search itself is cheap: $0.006 and 2 to 2.5 seconds
  the first time a request is seen, less when repeated because its scores are cached.
- **Against the $0.20 target:** 1 of 40 builds cost more than $0.20 on `main`, 5 of 40 after this change with
  examples off (all jeeps), 7 of 40 with examples on. The dearest build was $0.29.

Rounds in which the report showed each kind of error (a build has 3 to 8 rounds):

| Condition | Rounds | overlap | floating | material | separate | joint | fit | technic | Warnings |
|---|---|---|---|---|---|---|---|---|---|
| `main` | 181 | 36 | 43 | 7 | 2 | 1 | - | - | - |
| Examples off | 184 | 37 | 38 | 2 | 6 | 0 | 0 | 0 | vehicle 10, technic 2 |
| Examples on | 197 | 55 | 58 | 5 | 2 | 1 | 3 | 0 | vehicle 9 |

The new `[fit]` and `[technic]` errors took no round with examples off. Every warning was on the jeep: its spare
tyre "turns on another axis". That warning says nothing a build can act on, so it was removed, and the jeep and
the pickup were run eight more times each (on their own, so their times cannot be compared with the table):
pickup $0.059, all published; jeep $0.171, five of eight published. Over both passes the jeep published 12 of 16
times after this change against 8 of 8 before. What fails is its hand-placed spare wheel: the tyre a few LDU off
its rim's seat (`[fit]`), or the brick that carries it attached to nothing. The `[fit]` message was then changed to
say how far to move the part; that last change was not measured.

**Do the annotated sets pass Pip's checks?** Of about 30,700 described models and submodels, 2,735 convert and pass
every check apart from the catalog (2,504 distinct scripts: 166 whole models and 2,338 submodels, from 705 official
sets and 37 atlas models). Before this change 62 official sets passed, held to the catalog; now 139 pass whole.
What is not used: 15,460 have fewer than eight pieces left once minifigures are out, 5,166 lose more than a fifth
of their pieces to overlaps or joints the checks cannot find, 4,745 are mostly Technic, 641 are mostly built off
the stud grid, and about 1,090 fail for other reasons (a wheel not joined, a Technic joint not seated, too large).

## After the measurement

These changes came after the 136-build measurement above, so its numbers do not include them:

- **Examples are references.** An example keeps every part of its set except minifigures, including parts the checks
  cannot follow, Technic models and parts set at an angle, and sections of as few as 3 pieces. The library grew from
  2,504 to 16,850 scripts (1,294 whole models, 15,556 sections, 104 MB); 6,768 also pass Pip's checks. The prompt
  marks the others as using joints Pip's report cannot verify. For "a red fire engine with a ladder" Jev now returns
  five fire engines, where before it returned a locomotive nose and a truck cab.
- **Vehicle rules** as described above (request-aware errors, wheel space on real surfaces, plane and boat symmetry).
  Four real builds were run on them (an off-road jeep, a pickup with examples, a plane with examples, a tugboat): all
  published, at $0.11 to $0.24. They first showed false findings (the road under the tyres, a spare on the tailgate, a
  plane's display stand), which were fixed; rechecked, none of the four has a vehicle finding.
- **Technic parts redrawn by a library release** are recognised by their size and holes.

## Not verified

- A signed-in build on the live site, and the API image with `jev-rerank` installed: the Docker build of this
  branch was not run locally.
- Whether a measured joint is strong enough, balance, and whether a hand can reach a part. Nova's toolkit says the
  same of itself.
- The Technic registry was keyed to each part's exact geometry, so on the 2025 parts library on the development Mac
  16 of 50 measured parts were not recognised (all 51 are on the current release, which production downloads). A
  part is now also recognised when its outline is within 0.6 LDU and its holes are where they were recorded
  (`toolkit/data/technic-sizes.json`): all parts match on both releases. A future release that moves a hole or
  changes a part's size still turns that part's checks off; the report says how many parts that is, and
  `test_the_measured_technic_parts_are_recognised_in_this_parts_library` fails on such a library.
- Frames the connector data has no seat for (the 1 x 4 x 3 window and some doors) are still checked for touching
  only.
- Retrieval quality was looked at on a handful of requests, not scored. Where the library has no close model (no
  whole fire engine survived conversion) Jev returns loosely related sections.

## Where it lives

- `backend/fable_agent/connectors.py` (joints and misfits from connector data), `seats.py`, `vehicle.py`, `stock.py`
- `backend/fable_agent/toolkit/` (AGPL-3.0: Technic registry and review, connector adapter, vehicle review)
- `backend/fable_agent/data/shadow/` (CC BY-SA 4.0: connector data, `seats.json`)
- `backend/fable_agent/assembly.py`, `checks.py`, `joints.py`, `sequence.py`, `repair.py`, `prompts.py`
- `backend/fable_agent/examples/` (`retrieval.py`, `importer.py`, `library/`), `backend/scripts/build_fable_examples.py`
- `backend/fable_agent/guides/` (CC BY-SA 4.0)
- Tests: `backend/tests/test_fable_connectors.py`, `test_fable_assembly.py`, `test_fable_examples.py`,
  `test_fable_agent_assist.py`
- Guide: [docs/fable-agent.md](../fable-agent.md#publication-rules-the-v2-methods)
