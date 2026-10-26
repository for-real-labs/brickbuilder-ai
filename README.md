<p align="center">
  <img src="frontend/public/pets/pip.webp" alt="Pip, the BrickBuilder building buddy" width="160" />
</p>

# BrickBuilder

**A LEGO® building agent.** Tell Pip what you want to build, or give it a reference image. BrickBuilder uses an LLM to design the model, checks the build, and gives you a 3D preview, building instructions, a parts list, and downloadable LDraw files. You can ask for changes and keep building from the result.

## Choose your builder

| Mode | How it builds |
| --- | --- |
| **Basic bricks** | An OpenAI or Claude model designs shapes on a stud grid. BrickBuilder checks the design, shows the model a preview for revisions, and converts the result into bricks. |
| **All parts** | The [Nova agent](https://github.com/jjohnson5253/ldraw-nova) works with a wider parts catalog. It can search parts, write building scripts, render and check its work, and continue the same build when you ask for an edit. |

At [brickbuilder.ai](https://brickbuilder.ai), describe a build, optionally upload an image, choose **Basic bricks** or **All parts**, and press **Create**. For example: “Build a small red lighthouse with a blue door, about 20 studs tall.”

## Run on your computer

BrickBuilder is open source under the MIT license. Local AI generation uses your own provider account or API key; provider charges and subscription limits still apply.

### Let a coding assistant set it up

Copy and paste this into Claude Code or an equivalent coding assistant with terminal access:

```markdown
# Install and run BrickBuilder on my computer

Install and run the open-source app at https://github.com/for-real-labs/brickbuilder-ai on this computer. Do the setup, rather than only explaining the commands.

1. Detect my operating system and read the repository's current README and local setup scripts. Check Git, Node.js 18+, Python 3.10+, and Docker Desktop (or a working Docker engine). Install missing prerequisites from official sources when possible; tell me about any manual installation or permission needed. Start Docker for All parts mode.
2. Clone the repository into a new folder, or reuse an existing checkout without overwriting my changes. Work from the repository root.
3. Copy backend/.env-example to backend/.env and frontend/.env-example to frontend/.env only if those files do not exist. Keep VITE_API_MODE=local and VITE_LOCAL_API_URL=http://127.0.0.1:8002. Keep credentials private and out of Git, browser bundles, and chat.
4. Run npm install, then npm start. The root scripts install the Python backend and frontend, build the pinned Nova Docker runtime, and start the local services. Allow time and disk space for the first Docker build. Diagnose setup errors using the current repository documentation.
5. Open the frontend URL printed by Vite (normally http://127.0.0.1:3000). Verify that the frontend and local backend respond. For All parts, check npm run nova:status and guide me through the app's local OpenAI/Claude provider sign-in, or help me configure my own project API key privately. Let me complete authentication myself. Basic bricks needs an OPENAI_API_KEY or ANTHROPIC_API_KEY in backend/.env and a matching model selection. AI provider charges or subscription limits may apply.
6. If Docker is unavailable, offer Basic bricks only by setting NOVA_SKIP_SETUP=true for both npm install and npm start, using syntax appropriate for my shell. Explain that All parts will be unavailable in that mode.
7. Leave the app running and give me the local URL, a short status report, and stop/restart instructions. Ctrl+C stops the app servers; Nova's Docker container stays running. Do not claim a successful AI build unless one was actually tested with my authorization.
```

### Manual setup

Install **Git**, **Node.js 18+**, **Python 3.10+**, and a running **Docker Desktop / Docker engine** for All parts mode.

```bash
git clone https://github.com/for-real-labs/brickbuilder-ai.git
cd brickbuilder-ai
cp backend/.env-example backend/.env
cp frontend/.env-example frontend/.env
npm install
npm start
```

Only copy the environment examples for a new installation; preserve existing `.env` files when updating. The frontend example selects the local backend at `http://127.0.0.1:8002`. Keep private keys in `backend/.env`, never in `VITE_*` variables.

The root installer creates `backend/.venv`, installs frontend dependencies, and builds the pinned Nova Docker runtime. The first build can take several minutes and several GB of disk space. `npm start` starts or reuses Nova, then starts the backend and frontend. Open the URL Vite prints, normally **http://127.0.0.1:3000**.

- **All parts:** choose the mode and model in the composer. Connect your OpenAI or Claude account through the local sign-in dialog, or explicitly select your project API key. Complete authentication, then press **Create**. `npm run nova:status` checks the runtime.
- **Basic bricks:** set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in `backend/.env`, restart the backend, and select a model for that provider.
- **Without Docker:** set `NOVA_SKIP_SETUP=true` for both installation and startup. On macOS/Linux, use `NOVA_SKIP_SETUP=true npm install` and `NOVA_SKIP_SETUP=true npm start`. In PowerShell, run `$env:NOVA_SKIP_SETUP="true"` before both npm commands. All parts will be unavailable.

Describe a model, optionally add a reference image, and press **Create**. Successful builds offer a 3D preview, instructions, parts lists, and downloads; follow-up edits continue from your model. AI generation requires an authenticated provider or configured API key. Running locally does not make external AI services free.

Press **Ctrl+C** to stop the app servers; restart with `npm start`. Nova stays running in Docker with its saved sessions; stop its managed container in Docker Desktop when finished. If startup fails, check Docker is running, prerequisites are available, and the ports are free. Read the actual error before rerunning setup.

See the [LLM builder details](backend/README.md) and [Nova setup guide](docs/nova-agent-builder.md) for configuration and troubleshooting.

## License

[MIT](LICENSE). LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project.
