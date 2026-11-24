<p align="center">
  <img src="frontend/public/pets/pip.webp" alt="Pip, the BrickBuilder building buddy" width="160" />
</p>

# BrickBuilder

**A LEGO® building agent.** Tell Pip what you want to build, or give it a reference image. BrickBuilder uses an LLM to design the model, checks the build, and gives you a 3D preview, building instructions, a parts list, and downloadable LDraw files. You can ask for changes and keep building from the result.

## Use in ChatGPT

[Add the BrickBuilder plugin to ChatGPT](https://chatgpt.com/plugins/plugin_asdk_app_6abee10605488191a105dfe0a2f045d4) to build with BrickBuilder from your chats.

## Choose your builder

| Mode | How it builds |
| --- | --- |
| **Basic bricks** | An OpenAI or Claude model designs shapes on a stud grid. BrickBuilder checks the design, shows the model a preview for revisions, and converts the result into bricks. |
| **All parts** | The [Nova agent](https://github.com/jjohnson5253/ldraw-nova) works with a wider parts catalog. It can search parts, write building scripts, render and check its work, and continue the same build when you ask for an edit. |

At [brickbuilder.ai](https://brickbuilder.ai), describe a build, optionally upload an image, choose **Basic bricks** or **All parts**, and press **Create**. For example: “Build a small red lighthouse with a blue door, about 20 studs tall.”

## Run locally

Install **Node.js 18+**, **Python 3.10+**, and **Git**. For **All parts**, also install and start **Docker Desktop**; Nova runs in Docker.

```bash
cp backend/.env-example backend/.env
cp frontend/.env-example frontend/.env
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `backend/.env` for **Basic bricks**. For **All parts**, you can use a project API key or connect your OpenAI or Claude account through the local provider sign-in.

```bash
npm install
npm start
```

Open the local URL printed by the frontend server, choose a mode, and start building. If you only want **Basic bricks**, run both npm commands with `NOVA_SKIP_SETUP=true` to skip Docker and Nova.

See the [LLM builder details](backend/README.md) and [Nova setup guide](docs/nova-agent-builder.md) for more options.

## Build locally with Astrology

Astrology is an independent image-to-LDraw agent. It designs with physical parts from the Brickwith catalog, renders both sides of its model, and revises the design against the reference and its stud connections. It also accepts a text brief or an edit to a saved Astrology design.

On the website, approved accounts can choose **Astrology** in **Generation settings → Building agent** with **All parts** selected. The backend reads the comma-separated `ASTROLOGY_ALLOWED_EMAILS` setting and defaults to Nova when there is no allowlist.

Install the backend dependencies with `npm run install:backend`, install LeoCAD, and set `OPENAI_API_KEY` in your environment or `backend/.env`. LeoCAD can use its bundled parts library. Set `LDRAW_DIR` for a separate LDraw installation. On a headless Linux host, run the command under a virtual display such as `xvfb-run -a`.

```sh
npm run astrology -- "Build the house in this photo with fewer than 600 pieces" --image ./house.jpg --out ./house-build
npm run astrology -- "Make the door red" --edit ./house-build/design.json --out ./house-with-red-door
```

Each run uses a new output directory. Open `model.ldr` or `model.mpd` in BrickBuilder's importer, Studio, or LeoCAD. Both files contain construction steps. The directory also contains front and rear PNGs, a BrickBuilder parts CSV, and the editable `design.json`. Interrupted runs retain the last structurally checked design and the latest attempted revision in `draft.json`. Either can be passed to `--edit`. A completed run writes `result.json` with the piece count, visual assessment and estimated API cost for that run.

The engine supports upright bricks, plates, slopes, tiles, window frames, and other modeled details. It checks exact part/color availability, occupied space, the total piece limit and connectivity through vertical studs. Physical balance and assembly clearance still need a hands-on review.

## Build with Fable

Fable is a second independent All parts agent, in `backend/fable_agent`. The model writes one build script against a kit that measures every part from the LDraw library. Each change to the script is checked for overlapping, unattached and unavailable parts, and the model reviews renders before it may publish. It runs on Claude or OpenAI models.

On the website, the accounts allowed to use Astrology also see the Fable options in **Generation settings → Building agent** with **All parts** selected. Both agents share the `ASTROLOGY_ALLOWED_EMAILS` allowlist, and other accounts never see the selector. Fable needs `ANTHROPIC_API_KEY` for its Claude options and `OPENAI_API_KEY` for its OpenAI options, plus the LeoCAD and LDraw installation Astrology already uses.

Because the model writes the build script, the API runs it as untrusted code: in a restricted dialect, in a separate process with no credentials and hard limits, and under an unprivileged account (`FABLE_SANDBOX_USER`, created in the API image) that cannot read the API's environment. If that account is unavailable, Fable refuses to build rather than run a script as the API's own user.

Each option is one of two methods on one model. **Thorough** is a single long conversation in which the model looks parts up, edits and renders as often as it likes. **Lean** is a few short rounds that each show only the current script, its report and pictures, which costs much less. The **v2** options add ready-made trees (`tree()` in the build script) and an automatic repair that cuts plain parts back where they overlap and swaps colors a part is not sold in; thorough v2 is also given part measurements up front and batches its edits, so it takes fewer turns. The first versions are unchanged. Every change to an agent is recorded in [docs/agent-changes](docs/agent-changes/README.md). These are the results of one run each on the same photo of a lake house, with the one-line prompt "Build my lake house from this photo."

| Building agent option | Method | Model | AI cost | Model turns | Minutes | Parts | Parts cost |
|---|---|---|---|---|---|---|---|
| Fable · Claude Fable 5.2 | thorough | `claude-fable-5-2` | $3.65 | 8 | 12 | 572 | $90 |
| Fable · GPT-6.2 Sol | thorough | `gpt-6.2-sol` | $1.20 | 39 | 12 | 1,161 | $177 |
| Fable Thorough v2 · GPT-6.2 Sol | thorough v2 | `gpt-6.2-sol` | $0.46 | 15 | 9 | 1,282 | $164 |
| Fable · GPT-6.1 Sol | thorough | `gpt-6.1-sol` | $0.62 | 38 | 13 | 1,437 | $204 |
| Fable Lean · Claude Fable 5.2 | lean | `claude-fable-5-2` | $0.90 | 2 | 3 | 415 | $78 |
| Fable Lean · Claude Fable 5.2 (low effort) | lean, low effort | `claude-fable-5-2` | $0.53 | 2 | 3 | 427 | $84 |
| Fable Lean · GPT-6.2 Sol | lean | `gpt-6.2-sol` | $0.22 | 5 | 4 | 1,073 | $147 |
| Fable Lean v2 · GPT-6.2 Sol | lean v2 | `gpt-6.2-sol` | $0.18 | 5 | 3 | 988 | $146 |
| Fable Lean · GPT-6.1 Sol | lean | `gpt-6.1-sol` | $0.18 | 6 | 3 | 932 | $135 |

![The lake house built by each Fable option](docs/assets/fable-agent/lakehouse-methods.jpg)

Every build passed its checks. One run per option shows what each costs and roughly how it looks, not which is better on average. At low effort Claude built a plainer model, without the siding color and white trim. Lean on GPT-6.2 Sol kept the roof shape, dormer and lattice skirt but laid an olive ground instead of a green lawn. The thorough GPT-6.2 Sol run was made before a prompt-caching fix that would have saved about half of its cost. With that fix its cost is estimated at about $0.60, so thorough v2 at $0.46 is roughly a quarter cheaper, in 15 turns instead of 39.

To run Fable locally, install the backend dependencies with `npm run install:backend`, install LeoCAD and an LDraw parts library (`LDRAW_DIR`, default `~/ldraw`), and set the model's API key in your environment or `backend/.env`.

```sh
cd backend
python -m fable_agent build "Build my lake house from this photo" --image ./house.jpg --out ./house-build
python -m fable_agent build "A red fishing boat" --method lean --model gpt-6.1-sol --out ./boat-build
python -m fable_agent edit ./house-build "Make the roof dark red"
```

Each run writes a session directory with `published/001/model.ldr`, its build script, a parts list, the check report and renders. See [the Fable guide](docs/fable-agent.md) for how it works, what its checks do and do not prove, and its limits.

## License

[MIT](LICENSE). LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project.
