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

## License

[MIT](LICENSE). LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize, or endorse this project.
