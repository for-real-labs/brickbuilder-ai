# Nova full set agent

Choose **Full set agent** on the landing page to generate a complete LEGO-compatible
set from a description, reference image, or both. The existing Model builder is
still the default. The full set agent uses real LDraw parts, hierarchical
subassemblies and construction steps instead of restricting the design to solid
voxel shapes.

## Local setup

```sh
npm install
npm run setup:nova
npm start
```

The frontend opens at http://localhost:3000 and the backend binds to
http://127.0.0.1:8002. Nova setup requires Git and either Python 3.12+ or
[uv](https://docs.astral.sh/uv/). The backend uses its own Python environment;
Nova and Jev use a separate environment under the ignored `backend/.nova/`
directory. Set `NOVA_SETUP_PYTHON` to choose an installed Nova interpreter.

`setup:nova` downloads immutable upstream revisions, installs their tooling,
reuses or downloads the official LDraw parts library, and indexes it. It does
not install LeoCAD. Previews use actual LDraw triangle geometry rendered by
BrickBuilder's own software renderer, so special parts remain visible.

## Provider connections

Open **Local provider connections** below the landing-page builder controls.
These controls are only available against a local API. Connect either provider
account and then choose its **local account** connection in the full set agent,
or attach a provider API key and choose **Project API key**.

- **Sign in to ChatGPT** uses the official Codex CLI's browser login and native
  credential store. Install a missing CLI with `npm install -g @openai/codex`.
- **Sign in to Claude** uses the official Claude Code CLI's browser login and
  native credential store. Install a missing CLI with
  `npm install -g @anthropic-ai/claude-code`.
- **Sign in to fal.ai** uses the official fal CLI. After successful login, it
  creates a project API key with API scope and automatically attaches `FAL_KEY`.
  Install a missing CLI with `uv tool install fal`.
- Existing API keys can also be attached directly. Keys are atomically saved
  to the ignored `backend/.env` with owner-only file permissions and become
  available to the running backend immediately.

Subscription sign-in does not create a provider API key: the native CLIs retain
their sessions and the full set agent uses them directly. Native agent calls
disable built-in command/file tools; BrickBuilder executes only its own validated
LDraw tool requests. API mode uses the existing provider-neutral OpenAI Responses
and Anthropic Messages conversation adapters.

Local connection endpoints require an explicit server opt-in,
`BRICKBUILDER_LOCAL_PROVIDERS=true`, a loopback TCP peer, and loopback Host and
Origin headers. The local launcher enables this by default if it is not
explicitly disabled. Hosted deployments should leave it disabled. Credentials
are never returned by the API or stored in browser storage or analytics.

Provider account access and usage limits still apply. Official documentation:
[ChatGPT authentication](https://learn.chatgpt.com/docs/auth),
[Claude Code CLI](https://code.claude.com/docs/en/cli-reference), and
[fal CLI keys](https://fal.ai/docs/api-reference/cli/keys).

## Parts search and build loop

1. Read toolkit manuals and the assembly-plan schema, then plan subassemblies,
   visual features, materials and construction order.
2. Search installed parts, annotated models, submodels, examples and the
   construction catalog. Inspect dimensions and connector metadata.
3. Submit a self-contained JSON assembly plan. The pinned Nova compiler emits
   an MPD and runs geometry/connection checks. The agent cannot execute
   arbitrary generated Python or access arbitrary paths.
4. Inspect diagnostics and rendered review views, repair the plan, and repeat
   within the chosen agent-step and part limits.
5. Accept a checked, reviewed candidate and save the LDR, packed MPD, preview,
   and parts CSV through existing generation storage. Existing activity,
   cancellation, output, viewer and downloads are reused.

The pinned runtime bundles an annotated snapshot of the LDraw Official Model
Repository: 1,821 model files, 28,451 indexed submodel descriptions, and 35,257
indexed part descriptions. These counts describe the bundled corpus; reference
eligibility also depends on available geometry, part accounting and the search
filters. For example, `75954-1.mpd` includes the Hogwarts Great Hall tower-roof
sections, credited in the source to Stefan Frenz [smf].

The agent can inspect a search result's canonical identity or choose a section
from a bundled model. It extracts the section with its dependencies, reads its
real part numbers and quantities, and receives actual-geometry views from two
angles. Reference studies retain author and licence information and are included
under `references/` in the private agent-source ZIP. Activity output identifies
whether Jev ranked the results or keyword fallback was used.

Add your TypeSafe key to the ignored `backend/.env` file:

```dotenv
TYPESAFE_API_KEY=your_key_here
```

Restart the backend after saving, and leave **Use Jev semantic part search**
enabled under **Full set agent → Agent limits and part search**. This enables
[Jev semantic reranking](https://github.com/anteloc/jev-rerank). Without the key,
or if reranking is unavailable, full-text search remains available. Jev's key
is separate from OpenAI, Anthropic and fal credentials.

Geometry checks and previews help the agent find placement problems; generated
sets still need human construction review. Complex models may require larger
budgets and several minutes of provider usage.
The complete agent job also has a 30-minute limit. Set `NOVA_TIMEOUT_SECONDS`
between 60 and 7,200 seconds to change it for local development.

## SAM3D and Trellis through fal

The existing image-to-GLB mode uses the attached fal key for Trellis and SAM3D.
If a RunPod SAM3D worker is configured, live voxel streaming remains available.
Without RunPod, selecting SAM3D uses `fal-ai/sam-3/3d-objects`, waits for its mesh,
and passes that mesh through existing voxel and brick conversion. The UI receives
progress updates while the mesh is being generated.

## Runtime and attribution

The installer retains upstream source, licenses, references and attribution in
the external runtime. Source revisions are pinned in `scripts/nova.cjs`:

- [ldraw-nova](https://github.com/anteloc/ldraw-nova),
  `c4ba6c4913e0975ee7e34e647c26129137657d5e`, AGPL-3.0.
- [jev-rerank](https://github.com/anteloc/jev-rerank),
  `afe4045cddcf5684e43a7db68bc5f9a19f900dcc` (v0.5.0).
- [LDraw](https://www.ldraw.org/): the official parts library retains its own
  license metadata; reference models and manuals retain upstream attribution
  and applicable CC BY-SA terms.

The tracked integration contains adapters rather than copied Nova implementation
source. Distribution or hosting of the combined integration must respect upstream
license and corresponding-source obligations. Preserve toolkit licenses and
`ATTRIBUTION.md` with the runtime.

For deployment, install the same pinned runtime, set `NOVA_TOOLKIT_ROOT`,
`NOVA_PYTHON`, and `LDRAW_DIR`, and provide API keys on the server. Native
subscription connections are reserved for local development.
