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

## Build locally with Astra

Astra is an independent image-to-LDraw agent. It designs with physical parts from the Brickwith catalog, renders both sides of its model, and revises the design against the reference and its stud connections. It also accepts a text brief or an edit to a saved Astra design.

Install the backend dependencies with `npm run install:backend`, install LeoCAD, and set `OPENAI_API_KEY` in your environment or `backend/.env`. LeoCAD can use its bundled parts library. Set `LDRAW_DIR` for a separate LDraw installation. On a headless Linux host, run the command under a virtual display such as `xvfb-run -a`.

```sh
npm run astra -- "Build the house in this photo with fewer than 600 pieces" --image ./house.jpg --out ./house-build
npm run astra -- "Make the door red" --edit ./house-build/design.json --out ./house-with-red-door
```

Each run uses a new output directory. Open `model.ldr` or `model.mpd` in BrickBuilder's importer, Studio, or LeoCAD. Both files contain construction steps. The directory also contains front and rear PNGs, a BrickBuilder parts CSV, and the editable `design.json`. Interrupted runs retain the last structurally checked design and the latest attempted revision in `draft.json`. Either can be passed to `--edit`. A completed run writes `result.json` with the piece count, visual assessment and estimated API cost for that run.

The engine supports upright bricks, plates, slopes, tiles, window frames, and other modeled details. It checks exact part/color availability, occupied space, the total piece limit and connectivity through vertical studs. Physical balance and assembly clearance still need a hands-on review.

## License

[MIT](LICENSE). LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project.
