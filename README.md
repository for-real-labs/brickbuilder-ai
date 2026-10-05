<h1 align="center">BrickBuilder</h1>

<p align="center">
  <b>Use AI to design LEGO® models.</b><br/> Turn any image or text prompt into a buildable LEGO®-compatible brick model.</b><br/>
  <!-- Get a 3D preview, step-by-step building instructions, downloadable LDR/MPD files, and a parts list you can order. -->
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/jjohnson5253/brickbuilderai/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/jjohnson5253/brickbuilderai?style=flat" /></a>
  <a href="https://github.com/jjohnson5253/brickbuilderai/network/members"><img alt="GitHub forks" src="https://img.shields.io/github/forks/jjohnson5253/brickbuilderai?style=flat" /></a>
  <a href="https://github.com/jjohnson5253/brickbuilderai/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/jjohnson5253/brickbuilderai" /></a>
  <a href="https://github.com/jjohnson5253/brickbuilderai/commits"><img alt="Last commit" src="https://img.shields.io/github/last-commit/jjohnson5253/brickbuilderai" /></a>
  <img alt="Made with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" />
  <img alt="Made with Python" src="https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white" />
</p>

<p align="center">
  <img width="768" height="520" alt="github-readme-video (1)" src="https://github.com/user-attachments/assets/63added8-2404-45ce-a87c-df40c801ddf4" />
</p>

## What it does

Upload a photo or type a prompt, and BrickBuilder turns it into a real brick build:

### LLM-to-bricks

1. **Image or text in** — start from a reference picture, a prompt, or both.
2. **LLM design** — a Claude or OpenAI model describes colored shapes on a stud grid: boxes, ellipsoids, cylinders, and per-layer maps.
3. **Design and review** — Python turns those shapes into colored voxels, checks the draft's connections, and renders previews so the LLM can review and revise it.
4. **Brick optimization** — the accepted voxels go through the shared `glb2brick` / `voxel2brick` converter to produce the final brick model.
5. **Build it** — explore the model in 3D, follow the instructions, download the LDR/MPD, or order the parts.

This pipeline skips 3D reconstruction and mesh voxelization. It still uses voxels internally: the LLM designs the geometry instead of reconstructing a 3D mesh from an image. The final brick packing uses the same optimizer as image-based builds.

Configure `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in `backend/.env` for your selected model. See the [backend README](backend/README.md) for `/llmToBricks`, model options, and design settings.

### Image reconstruction and voxelization

The image-based pipeline uses Trellis to reconstruct a 3D mesh and voxelizes it, or takes colored voxels directly from the SAM-3D stream. Those voxels then enter the same brick optimizer and export flow. Generation time is typically under 30 seconds when SAM-3D is used.

The landing page also offers an optional **Full set agent** powered by
[LDraw Nova](https://github.com/jjohnson5253/ldraw-nova). It runs the installed Nova
Nova agent and tools in a private service; BrickBuilder saves its models and
continues follow-up edits in the same Nova session. The existing builder remains
the default. See [Nova setup and provider connections](docs/nova-agent-builder.md).
The managed runtime checks upstream default branches at backend startup. Use
`npm run update:nova` to refresh it or `npm run nova:status` to inspect it;
compatible construction features are exposed through generated upstream wrappers.

## Examples

<p align="center">
  <img src="frontend/public/assets/demo-images/Pokemon.png" width="180" />
  <img src="frontend/public/assets/demo-images/Link.png" width="180" />
  <img src="frontend/public/assets/demo-images/Octopus.png" width="180" />
  <img src="frontend/public/assets/demo-images/Nyan%20Cat.png" width="180" />
</p>

## Project layout

| Folder | What it is | Stack |
| --- | --- | --- |
| `frontend/` | Web app: upload, 3D viewer, instructions, checkout | React, Vite, TypeScript, Three.js, Tailwind, Supabase, Stripe |
| `mobile/` | iOS-first native shell reusing every web-app feature | Expo, React Native, EAS, WebView |
| `backend/` | API that converts images/text into brick models | fal.ai Python, FastAPI, Open3D, Trimesh |
| `serverless/` | Image-to-3D voxel generation worker | SAM-3D, Docker, RunPod |

## Running locally

<details>
<summary>🤖 <strong>AI Setup Prompt</strong> — Copy this prompt to your AI assistant to set up the project automatically</summary>

```
Help me set up and run the BrickBuilder project locally.

Prerequisites I need installed:
- Python 3.10+
- Node.js 18+

Steps:
1. Copy backend/.env-example to backend/.env and frontend/.env-example to frontend/.env
2. Ask me for my fal.ai API key and set FAL_KEY in backend/.env
3. Run `npm install` to install dependencies (uses Python venv/pip for backend, npm for frontend)
4. Run `npm start` to start both the backend API (port 8002) and frontend dev server. The backend server will take a minute to start the first run as it builds c++ executables.

The backend is a FastAPI server, frontend is React+Vite. Let me know if any dependencies are missing.
```

</details>

### Prerequisites

| Requirement | Notes |
| --- | --- |
| **Python 3.10+** | [python.org/downloads](https://www.python.org/downloads/) |
| **Node.js 18+** | [nodejs.org](https://nodejs.org/) |
| **fal.ai account** | Sign up at [fal.ai](https://fal.ai/) and get an API key |

### Environment setup

1. Copy the example env files:
   ```bash
   cp backend/.env-example backend/.env
   cp frontend/.env-example frontend/.env
   ```

2. Set your fal API key in `backend/.env`:
   ```
   FAL_KEY=your_fal_api_key_here
   ```

3. (Optional) Configure Supabase, Stripe, and other integrations in the `.env` files as needed. A local postgres database will be spun up if supabase is not connected.

### Install & run

```bash
npm install
npm start
```
Run these commands from the repository root. `npm install` creates `backend/.venv` and installs the pinned Python dependencies with pip, then installs the frontend dependencies. `npm start` launches both dev servers; Ctrl+C stops both, and if either server exits the other is stopped too. Python 3.10+ must be installed; if needed, set `PYTHON` to the path of your Python executable. uv is not required for local setup. You can also run just one server with `npm run start:backend` or `npm run start:frontend`.

Voxelization with SAM-3D produces better results than Trellis, but it runs as a separate worker that you host on RunPod. To enable it, deploy the SAM-3D image on [RunPod](https://www.runpod.io/)

Since the LEGO pipeline only needs voxels, BrickBuilder streams SAM3D's geometry/appearance callbacks and stops after the final colored voxel output. This avoids the extra mesh decoding and GLB export step, reducing end-to-end generation time.

The SAM3D worker image is published publicly on Docker Hub as `jjohnson5253/manifold-sam3d:latest`, so you can deploy it on RunPod without building it yourself:

1. In the [RunPod Serverless console](https://www.runpod.io/console/serverless), create a new endpoint.
2. Set the container image to `jjohnson5253/manifold-sam3d:latest` (leave container registry auth blank — the image is public).
3. Pick a GPU with enough VRAM (an H100 is recommended for SAM-3D).
4. Attach a network volume to the endpoint and mount it where the model weights are cached. The weights are large, so the volume keeps them warm across workers and avoids re-downloading them on every cold start, which makes the endpoint load much faster.
5. Deploy, then copy the endpoint ID and your RunPod API key into `RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY` in `backend/.env`.

See `serverless/README.md` if you want to build and push your own image instead.

## Mobile app (iOS-first)

The Expo app in [`mobile/`](mobile/) wraps the deployed web app so generation,
the dashboard, generated-model view, ordering, and the block editor continue to
use the same frontend and backend business logic. It adds a small native
navigation shell, safe-area handling, upload permissions, and EAS build/submit
profiles. See [`mobile/README.md`](mobile/README.md) for local development and
TestFlight/App Store steps.

## Testing

Pull requests run isolated backend and frontend test jobs in GitHub Actions. The
tests mock external APIs and storage, so no production credentials are needed.

```bash
# Setup and startup scripts
npm test

# Backend
npm run install:backend
cd backend
.venv/bin/python -m pytest

# Frontend (unit tests and coverage gate)
cd ../frontend
npm ci
npm run test:coverage
```

## Feedback agent flow

Authorized admins can submit a product change and screenshots in the app. A
Supabase Edge Function starts a Copilot task from `staging`; GitHub's
`copilot_work_finished` event and Vercel's successful Preview deployment are
joined by commit SHA before the requester receives an authenticated preview
link. Requests made in the iOS shell reuse the same flow, then create an
exact-commit EAS build, deliver it through TestFlight, and email the requester
when Apple marks it ready. Approval merges the feature PR into `staging` and
leaves a `staging` to `main` PR for human review. See
[the setup and architecture guide](docs/feedback-agent-flow.md).

![Feedback agent and admin flow](docs/assets/feedback-agent-loop.png)

## Attributes
- Legolization: https://github.com/AvaLovelace1/BrickGPT/
- Image-to-3D Streaming: https://github.com/rehan-remade/Manifold

## License

This project is licensed under the [MIT License](LICENSE).

> LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project
