# Fable building agent

Fable is a from-scratch replacement candidate for the Nova "All parts" agent. It
turns a prompt and an optional reference photo into an LDraw model made only of
parts the supplier stocks. Nova was the reference for what the job is; none of its
code is used.

**Status:** a standalone agent you run from the command line. It is not wired into
the website's **All parts** mode yet. Nova keeps serving that mode until Fable has
been compared with it on real requests.

| | Nova | Fable |
|---|---|---|
| Where it lives | Two pinned external forks, built into a multi-GB Docker image | `backend/fable_agent`, plain Python in this repository |
| What it needs to run | Docker, LeoCAD, the full LDraw library, optional Jev search key | The backend's Python environment, an LDraw library, LeoCAD for pictures |
| How the model builds | Shell, Python and a large CLI, guided by a dozen manuals it reads first | One build script written against a small kit, plus eight tools |
| Placement | Raw LDraw origins and matrices | A stud grid; the kit measures each part from the library |
| Physical checks | A CLI the model chooses to run | Run on every script change; `finish` is refused until they pass |
| Parts inventory | Palette pushed into Nova | The same `PartsCatalog`, enforced in every build report |
| Models | One provider per deployment | Claude or OpenAI models, chosen per run with `--model` |
| Default AI budget | $20 per generation | $8 per run, enforced before each call |

## Example

Built unattended by `claude-fable-5-2` from a customer photo of a lake house and the
one-line prompt "Build my lake house from this photo." The run took 8 model turns and
$3.65 of AI spend, and published a model of 572 parts in 81 part/color lots, about
$90 of parts at catalog prices. Every part is in the supplier catalog, nothing
overlaps, and every part is attached. A follow-up `edit` on that session ("Make the
roof dark red and add a chimney.") took 2 more model turns and $1.22.

![Lake house, front left](assets/fable-agent/lakehouse-front-left.png)
![Lake house, front](assets/fable-agent/lakehouse-front.png)
![Lake house, front right](assets/fable-agent/lakehouse-front-right.png)

The script the agent wrote is kept, unedited, as
[`backend/fable_agent/examples/lakehouse.py`](../backend/fable_agent/examples/lakehouse.py).
Rebuild, check and render it without any model call:

```sh
cd backend
python -m fable_agent script fable_agent/examples/lakehouse.py --out /tmp/lakehouse
```

## Running it

From `backend`, with its Python dependencies installed:

```sh
python -m fable_agent build "Build my lake house from this photo" \
  --image ~/Downloads/lakehouse.jpeg --out ../output/fable-agent/lakehouse

python -m fable_agent edit ../output/fable-agent/lakehouse "Make the roof dark red"
```

It needs:

- `ANTHROPIC_API_KEY` for Claude models or `OPENAI_API_KEY` for OpenAI models, in the
  environment or `backend/.env`.
- An LDraw parts library at `$LDRAW_DIR` (default `~/ldraw`).
- LeoCAD on `PATH`, at `$LEOCAD_BIN`, or in `/Applications` on macOS.

Useful options: `--budget 8` (USD), `--max-steps 60`, `--max-parts 1500`,
`--effort high`, `--model claude-fable-5-2`, `--catalog other.csv`, and `--all-parts`
to lift the supplier restriction.

`build` refuses to reuse a directory that already holds a session. `edit` continues
that session with the model that started it.

### Models

The model's name picks the provider. `--model claude-fable-5-2` is the default;
`claude-opus-5-5` is a cheaper Claude. Names starting with `gpt-` go to OpenAI, for
example `--model gpt-6.1-sol`. The agent loop, tools, checks and session format are the
same for both; only the client differs (`provider.py` for Claude, `openai_provider.py`
for OpenAI).

A model can be used only if `PRICES` in `backend/fable_agent/provider.py` lists it,
because the spending limit cannot be enforced without prices. Add a row to use a new
model.

OpenAI requests are stateless (`store: false`): nothing is kept in a stored OpenAI
response, and the model's reasoning is carried forward by sending each reasoning item
back as it arrived.

Prompt caching decides what a long build costs, because every step re-sends the whole
conversation. The system prompt is sent to OpenAI as a leading developer message
rather than as `instructions`: when this was written (2026-11-22), `gpt-6.2-sol` and
`gpt-6.2-astra` cached the conversation but never top-level instructions, while both
forms cached on `gpt-6.1-sol`. `cache_read_tokens` in a session's `usage` shows
whether caching is working for a model.

## How a build works

1. The model receives the request, the reference photo, a frozen system prompt and
   a parts sheet generated from the catalog: the most widely stocked parts in each
   category and every available color.
2. It writes a **build script**. The script is the model's source of truth; every
   change to the model is a change to the script.
3. Each `write_script` or `edit_script` call runs the script, then returns a
   **build report**: part count, size, overlapping parts, unattached parts,
   unavailable part/color pairs and an estimated parts cost.
4. It calls `render` to look at the build from any side, or zoomed on a region.
5. `finish` publishes. The harness refuses it while the report has errors or the
   current revision has not been rendered.

If a run hits its step or budget limit first, the last error-free revision is saved
as a **draft** rather than lost. A model refusal ends the run without publishing.

### Tools

`search_parts`, `inspect_part`, `view_parts`, `write_script`, `edit_script`,
`read_script`, `render`, `finish`. There is no shell, no file access and no network
tool.

`inspect_part` answers from measured geometry rather than from memory: footprint,
height, a height map that shows which way a slope faces, stud positions and
available colors.

### The build script

Scripts use a stud grid: `x` to the right and `z` to the back in studs, `y` up in
plates. A placement names the min corner of the part's footprint and the height of
its base. The kit works out the LDraw origin and matrix.

```python
module("walls")
door = rect(5, 0, 7, 1)
for course in range(5):
    cells = ring(0, 0, 12, 8) - (door if course < 4 else set())
    fill(cells, 1 + 3 * course, "Sand_Blue")          # bonded brick courses
frame = place("60592", "White", 2, 4, 0)              # a window
inset("60601", "Trans_Clear", frame)                  # its glass
row("3039", "Dark_Bluish_Grey", 0, 16, 0, 6, facing="front")   # a course of roof slopes
```

`fill` packs cells with the largest available bricks, plates or tiles in that color
and staggers seams between layers so walls bond and ring corners interlock.
`facing` aims a slope's low edge without the model reasoning about rotation
matrices. The full list is in `SYSTEM` in `backend/fable_agent/prompts.py`.

## What a session contains

```
session.json      frozen system prompt and tool list, settings, usage, status
transcript.json   the append-only conversation (pictures are file references)
reference.jpg     bounded, re-encoded copy of the customer's picture
build.py          current script;  scripts/NNN.py holds every revision
model.ldr         current build;   report.json holds its checks
renders/          every picture the model looked at
published/001/    model.ldr, build.py, bom.csv, report.json, preview.png, four views
```

The transcript is never edited. A model's reasoning is valid only against the exact
system prompt, tool list and history that produced it, so a session keeps its own
copy of the prompt and tools and only ever appends. This also keeps the provider's
prompt cache warm from one step to the next.

## What the checks prove

The report covers part availability and quantity limits, overlapping parts,
stud-to-part connections, parts that float, and separate free-standing assemblies.
Part shapes are sampled from library geometry in half-stud columns, so slopes,
inverted slopes, arches and panels are checked against their real profile.

It does not cover clips, bars, hinges, balance, or whether a hand can reach a part.
Parts on rotations that are not multiples of 90 degrees are not overlap-checked.
Reports say this, and every report carries `physical_validity: not_proven`.
When Fable is wired into the site, its models should go through the existing
supplier and instruction checks before a customer is charged, as Nova's do.

## Safety

- **Build scripts run in a restricted dialect.** Imports other than `math` and
  `random`, classes, underscore and frame attributes, `str.format`, and builtins
  that reach files or the interpreter are rejected before execution.
- **They run in a separate process** with a scrubbed environment (no API keys), an
  empty working directory, CPU and file-size limits and a wall-clock timeout.
- This is defense in depth, not a sandbox boundary on its own. A multi-tenant
  deployment should still run builds under an unprivileged account or container.
- **Spending is capped per run.** Before each call the remaining budget must cover
  the whole context at the highest input rate; the rest bounds output tokens.
  Unknown models and missing usage fail closed.
- **Reference pictures** are re-encoded, which drops EXIF such as GPS position.
  They are sent to the model provider, as with the other generation modes.
- **API keys** are read from the environment, sent only to their own provider, and
  never written to a session, a log or an error message.
- Supplier prices and SKUs never reach the model: it sees only which part/color
  pairs exist.

## Not done yet

- No web integration: no generation row, progress events, credits or storage.
- Instruction steps are grouped by height. The existing connected-step planner
  should run on published models, as it does for Nova.
- Rendering depends on LeoCAD. The API container does not ship it today.
- Doors hung in frames and other clip or hinge connections are placed by `inset`
  or `connect` and are not verified.

## Tests

```sh
cd backend
uv run --group dev pytest tests/test_fable_agent_*.py
```

The tests build a tiny synthetic LDraw library, so they need no parts library,
renderer or network.
