# Nova mode

Nova mode runs the real upstream Nova agent. BrickBuilder supplies the existing
composer, generation jobs, notifications, viewer and saved model collection.
Nova owns prompts, tools, provider conversations, script execution, search,
validation, rendering and publication. BrickBuilder adds a completion policy over
Nova’s geometry and connection evidence. Follow-up edits continue the same Nova
conversation and workspace.

All parts mode now uses Brickwith's exact part/color catalog. See
[Supplier parts restrictions and pricing](nova-parts-catalog.md) for catalog
sources, refresh instructions, the publication gate and custom inventory input.

## Local setup

Install Docker Desktop, then run:

```sh
npm install
npm start
```

Both Nova repositories must be installed together, and the Nova runtime must be
running for **All parts** generations and AI edits to work. The toolkit is a
dependency of the Docker/web app; it is not a second server to start separately.
This follows [Nova's installation instructions](https://github.com/jjohnson5253/ldraw-nova#installation):
combine compatible repositories, build their Docker image, then run the app.

The root `npm install` fetches two immutable fork revisions into ignored
`backend/.nova/toolkit` and `backend/.nova/web`. It builds the upstream Dockerfile
with the toolkit as its additional build context. BrickBuilder adds the
private tenant gateway, generation cost guard, and artifact export adapter in `backend/nova-service`.
Generic palette enforcement is native to the pinned Nova forks. Supplier catalogs
and prices stay in BrickBuilder; only availability is sent to Nova.
LeoCAD, the official parts library, Jev, provider SDKs and Nova's sandbox come
from the upstream image. The first build can take several minutes and several
GB of disk space. `npm start` starts or reuses the managed container, waits for
its authenticated runtime endpoint, and then starts the BrickBuilder API. It
does not rebuild or replace a healthy matching container on every API restart.
`npm run install:nova` builds just Nova; `npm run start:nova` starts just its
runtime. `npm run setup:nova` and `npm run update:nova` build and start the
configured pins. `npm run nova:status` inspects status without rebuilding.
Ctrl+C stops the BrickBuilder dev servers but leaves Nova running with its
persistent sessions/settings, matching upstream's detached Docker startup.

The runtime listens on `127.0.0.1:8778`; set `NOVA_SERVICE_PORT` before install/start to
choose another port. The generated `connection.json` and `service.env` contain
a random server token and are owner-readable and ignored by Git. They are never
sent to the browser. Setup preserves session data and the protected provider
configuration across rebuilds. It replaces only this installation's managed
container, whose name is derived from the installation directory. Other Nova
installations are never stopped. If using a remote service, set both
`NOVA_SERVICE_URL` and `NOVA_SERVICE_TOKEN` in `backend/.env`; npm checks that
service instead of building/starting another container. For Basic bricks only,
set `NOVA_SKIP_SETUP=true` for both install and start.

Choose **All parts (beta)** in the mode dropdown below the landing-page prompt.
**Basic bricks** uses the standard BrickBuilder LLM-to-bricks workflow. The model
dropdown applies to either mode, and **Upload image** adds a reference for either
workflow. Press **Create** inside the prompt bar to start a build. The selected API key
is forwarded from the backend to the private Nova provider configuration.
**Local provider connections** signs into Nova's own provider session once the
runtime is installed. OpenAI uses Nova's device login; Claude uses Nova's SDK
browser login and optional manual code. Native connections are localhost-only.
No host provider credential directory is mounted into the runtime.

On a local install, choosing **All parts** or another model checks that provider's
connection. If no account is connected, a login modal opens using Nova's own
ChatGPT/Claude login flow. Once connected, later builds reuse the saved session.
An existing project API key can be selected explicitly instead. Basic bricks
and hosted website builds retain their existing API-key flow. Nova stores OAuth
sessions in its protected per-tenant configuration volume, not in browser storage
or the Supabase generations table. Closing the modal preserves the model/prompt;
press **Create** after connecting to start the build.

The generation adapter selects Nova's **Agent** mode with **Full** tool
permissions so builds run automatically in their isolated workspace. Initial
prompts and edits select Nova's quick-preview workflow, low default reasoning
effort where supported, and its shorter 24-step limit. **Verify Build** restores
the normal model effort, complete workflow, and 150-step limit. BrickBuilder has no default wall-clock
cutoff for Nova; builds continue until Nova finishes or the owner cancels them.
An operator can explicitly set `NOVA_TIMEOUT_SECONDS` (60–86400 seconds);
unset or `0` disables that limit. Progress labels come directly from Nova,
without additional Claude or OpenAI summarization calls. Failed or cancelled
Nova cards offer **Resume build**, preserving the original conversation,
workspace and provider settings instead of starting over.
Describe scale and part preferences in the prompt. There are no separate
BrickBuilder planning prompts or render loop. The runtime publication wrapper
and final import enforce the connectivity policy below.

Set `TYPESAFE_API_KEY` in the ignored backend environment to configure Jev in
Nova's protected settings. Nova chooses its own search workflow and fallback.
Other BrickBuilder generation modes and fal connections remain available.

## Generation limits

OpenAI and Claude generations in Basic bricks and All parts share an owner limit
of 10 running generations. Admission is serialized in PostgreSQL across API workers;
completed, failed, and cancelled jobs free their slots. An eleventh request receives
HTTP 429 with a message to wait or cancel a running job. Apply
`20261005000001_generation_concurrency_limit.sql` before deploying the backend.
Local embedded PostgreSQL installs the matching trigger automatically.

Each generation, including each follow-up edit or resumed Nova turn, has a $10 USD
AI budget across all provider/tool rounds. Direct API calls reserve conservative
input costs and cap output tokens before each call, then account for reported
input, cached input, cache writes, and output (including reasoning). Missing usage
or unknown pricing fails closed. Nova's API bridge uses the same accounting and
disables automatic provider retries; its Claude SDK receives `max_budget_usd=10`
and rejects over-budget results. SDK budget checks can stop a turn after its final
provider response, so any already-incurred provider charges cannot be reversed.
Over-budget generations fail and do not deduct the user's generation credit.

Rebuild Nova with `npm run setup:nova` after upgrading the cost guard, and deploy
the rebuilt Nova image alongside the API. The API refuses to start All parts
generations on an older runtime without the $10 guard. Prices in
`backend/src/utils/generation_budget.py` are the standard API rates verified on
October 5, 2026 and need updating when provider prices change.

The model dropdown also exposes **SAM3D** and **Trellis** under **Other**. Those
models use the existing image/text-to-3D pipeline rather than an LLM mode.

## Saved generations and edits

All parts requests now save an **unchecked preview** first. The preview is ready
for 3D viewing, parts estimates, downloads, and follow-up edits without a mandatory
inventory/geometry/contact/instruction review or synchronous rendering pass.
Nova still selects parts from the protected availability palette; preview results
have no availability, quantity, connection, or buildability guarantee.

Once satisfied with the design, its owner can click **Verify Build** beside the
viewer. This creates another generation/revision, charges the existing one-credit
rate on success (one additional credit), and runs Nova's normal full workflow.
The selected saved Nova model ID is passed explicitly, so an earlier saved revision
cannot silently verify a newer model in the same conversation. Lost workspaces
recover the saved geometry through the existing import flow. Cancellation, private
progress, notifications, and the displayed previous revision work as for AI edits.
Typed edits always return to preview mode, including edits after verification.

Apply `20261009000000_nova_preview_verification.sql` before deploying the API.
`generations.nova_build_mode` is `preview` or `verify` for new Nova requests;
only a completed verify generation has passed the independent import gate.
Legacy rows remain NULL and retain their checked-instruction recovery behavior.
Preview rows cannot serve or implicitly generate construction instructions;
both the API and instructions page direct the user to **Verify Build** first.
Previews do not create the versioned reviewed-instruction cache.

On publication, the adapter imports the original hierarchical MPD, Nova's
preview, and a flat physical-placement export for existing viewer/parts-list
consumers. Flattening uses Nova's own parser, part classification and occurrence
transforms. The canonical MPD keeps the original hierarchy, construction steps
and embedded part source. BrickBuilder packs that MPD with library dependencies
for its existing download/instructions workflow.

Every run creates a normal `generations` row. A successful edit creates another
revision in the existing generation family. Completed revisions remain usable
while Nova works. The **Edit** composer sends a follow-up message to Nova; it
does not send Nova models through the voxel builder.
Request size changes in that composer too; the voxel resize controls are hidden
for Nova models so subsequent edits keep using their original Nova workspace.

**Building Instructions** uses BrickBuilder's existing step-by-step viewer,
including Previous/Next, highlighting new parts, the per-step parts panel and
PDF exports. The installed Nova parser expands the original MPD hierarchy into
physical placements while retaining the subassemblies' authored steps, world
transforms and inherited colors. Embedded part definitions remain available
but are not counted as building placements. Existing Nova models recover their
instructions from the saved source archive on first use; completed instruction
geometry can be shared while conversations and provider configuration stay private.

**Edit with AI** continues the original Nova conversation. The completed model
stays visible during the edit; progress, cancellation and “This can take up to
30 min. You can close this window safely.” appear in the top-left corner of the
3D view. Manual voxel editing is unavailable for All parts models.

The private `generation-output` bucket retains:

- `nova-instructions-reviewed-v1.ldr`: reviewed physical placements with construction steps.
- `nova-session.json`: tenant/session identity, published model identity, model
  connection settings and exact upstream source revisions; no credentials.
- `nova-source.zip`: the original MPD, reviewed flat and instruction exports,
  `build-review.json`, preview, original Nova BOM,
  conversation and bounded workspace source/review files.

These files are read only through owner-checked backend operations. Public model
links do not expose Nova sessions, conversations or private source archives.
The `generations.mode` column stores `basic_bricks` or `all_parts`, including
follow-up revisions. Apply `20261005000000_generation_mode.sql` before deploying
the application update; it backfills existing models and keeps older API
deployments assigning the correct mode through a database trigger. Cancellation and timeout
also cancel the active Nova turn; its durable session remains available.
Old generations from the previous PR implementation retain source downloads but
do not have a resumable Nova session.

## Connectivity and instruction completion gate

Rebuild and deploy the Nova runtime together with the API for this change. The
API requires `build_review_version: 1` before starting a generation, edit, or
resume; older runtime images cannot silently skip the policy.

The runtime wraps `publish_model` with a mandatory build review for verification
turns. Explicit preview turns skip that gate and publish visibly unchecked models.
Preview export flattens geometry for the viewer in a private unprivileged workspace;
it emits no review receipt or checked instructions. Verified export independently
reviews the captured bytes as described below. It runs Nova's
assembly/geometry validator and forces `contacts=all`, including above the
500-placement automatic-contact threshold. Geometry errors, incomplete or
truncated contact evidence, and multiple final connected groups block
publication. Nova receives a bounded report with affected steps and source
locations so it can repair its generator and retry within the existing turn.

Every prefix of the exact exported instruction sequence must contain one
connected group, beginning with step 1. Pieces added together may connect through
other pieces in that same step. A later bridge does not clear an earlier floating
step. The exporter and reviewer share the same mapping of authored nested and
repeated subassemblies to viewer steps; no geometry or steps are silently moved.
The current flat viewer does not present detached subassembly callouts. Such
assemblies, loose scenery, and intentionally separate objects must be resequenced
or combined into connected steps to pass this conservative policy.

The gate uses Nova's optimistic graph (confirmed and potential connector matches),
not only its confirmed graph: the toolkit deliberately labels some ordinary
stud/socket fits as potential. This enforces available connection evidence;
it does not prove physical fit, clutch strength, stability, insertion order within
a step, or general collision freedom. Missing metadata may require simpler parts
or improvements to Nova's connector coverage. There is no agent-authored override.

Before final export, the runtime independently reviews a captured model revision
again in a private temporary workspace as `nobody`, using the immutable toolkit
and no provider credentials. Agent-written review files cannot authorize
completion. The API verifies the receipt's hashes against the imported source,
display geometry, and instruction bytes before saving checked instructions,
charging a generation credit, or marking the build completed. Failed builds retain
their Nova session for repair/resume.

Existing models ignore the old unchecked instruction cache. Their original source
is reviewed on the first request, and a successful result is saved under the new
versioned cache name. Failed review returns a repair message instead of serving
unchecked steps. Existing saved model geometry and private source remain available.

Run the focused unit tests:

```sh
backend/.venv/bin/python -m pytest \
  backend/tests/test_nova_build_review.py backend/tests/test_nova_service.py \
  backend/tests/test_nova_gateway.py backend/tests/test_nova_instructions.py \
  backend/tests/test_nova_to_bricks.py
```

The real-library smoke suite can run without credentials or network against a
prepared Nova image:

```sh
docker run --rm --platform linux/amd64 --network none \
  --entrypoint /opt/ldraw-nova/.venv/bin/python \
  -v "$PWD/backend/nova-service:/review:ro" \
  -v "$PWD/backend/tests/nova_build_review_smoke.py:/smoke.py:ro" \
  ldraw-nova-app /smoke.py
```

The runtime CI also runs `backend/tests/nova_preview_runtime_smoke.py` in the
built image without network access. Scripted provider responses exercise a
one-round preview, selected-revision verification, real palette/connection checks
and rendering, both artifact exports, and per-turn usage accounting. No provider
credentials or paid generation calls are used.

## Hosted runtime

The API and Nova service are separate containers. The API Dockerfile does not
install a second agent. Keep the Nova service private and configure:

```dotenv
# On the BrickBuilder API:
NOVA_SERVICE_URL=http://nova.railway.internal:8000
NOVA_SERVICE_TOKEN=<same-random-secret-as-the-runtime>

# On the Nova service:
NOVA_SERVICE_TOKEN=<same-random-secret-as-the-api>
```

Use a persistent volume mounted at `/data` for conversations/workspaces and
another at `/config` for protected provider configuration. The Nova container
can use one volume instead: set `NOVA_CONFIG_ROOT=/data/provider-config` on the
service, with the volume mounted at `/data`. Provider config remains root-only.
The container
listens on port 8000 and must run as root so upstream Nova can drop tool
subprocesses to separate unprivileged accounts. The gateway gives each
BrickBuilder owner a separate upstream backend process, provider config, Unix
sandbox user and toolkit cache; immutable code/reference resources are shared.
Native local sessions use a separate local tenant. Do not expose the upstream
single-user backend directly to the internet.

On Railway, add a `nova` service in the same environment, using the BrickBuilder
repository and the `staging` branch. Set its Dockerfile path to
`backend/nova-service/Dockerfile`, with the repository root as build context.
Set `NOVA_BIND_HOST=::` for Railway's private IPv6 network and keep the service
private. The generated Dockerfile fetches the two pinned forks and follows
their build recipe; no separate deployment of either Nova repository or private
registry credentials are needed. Add a `/data` volume and set
`NOVA_CONFIG_ROOT=/data/provider-config`.

The staging API already deploys automatically from its `staging` branch. This
Nova service can do the same for changes to `backend/setup_nova.cjs` and
`backend/nova-service/**`. After updating pins, run `node scripts/nova.cjs
--prepare` and commit the regenerated Dockerfile before pushing.

Build the deployment image with the same installer:

```sh
node scripts/nova.cjs --prepare
docker build --platform linux/amd64 \
  --build-context nova=backend/.nova/toolkit \
  -f backend/.nova/Dockerfile.service -t your-registry/brickbuilder-nova:VERSION \
  backend/.nova/web
```

The fork's Dockerfile supplies its dependency versions and checksums. The
Nova application source comes from the pinned fork. Hosted Claude API-key models select the fork's opt-in Claude Agent SDK path, matching browser-login Nova's agent loop while retaining API-key billing. OpenAI retains its upstream transport. The `Nova runtime image` GitHub
workflow builds the hosted recipe and publishes commit-tagged images on main,
staging or explicit dispatch. PR builds validate without publishing.

Set the selected provider API key on the BrickBuilder API. The adapter provisions
it only in that owner's protected Nova config. Native account connections remain
local. Each service replica needs the persistent volumes for the sessions it
serves; route a session consistently to its volume. `NOVA_MAX_WORKERS` bounds
concurrent resident workers (default 16); capacity errors fail visibly instead
of bypassing the isolation boundary.

### Shared reference indexes and cache retention

The public LDraw reference catalog, filtered candidate databases, and Jev text
indexes live once per toolkit revision under `/data/reference-cache`, rather
than once per owner. A local Unix socket broker authenticates callers using their
Unix identity and accepts only bounded reference indexing, search, and inventory
operations. It runs the pinned immutable toolkit, serializes index writes, and
gives agents read-only access to the public indexes. Custom libraries/indexes
remain owner-local. Shared Jev databases do not store private query scores;
query-bearing search results are cached inside each owner's private toolkit cache.

The gateway checks hourly for seven days of inactivity. Owner search caches are
removed only after any resident worker is confirmed idle and stopped. Shared
filtered search indexes expire independently after seven days without use, and
private cached result files also expire individually after seven days without use.
an entire shared toolkit revision expires after seven days without reference
activity, once all resident workers are confirmed idle. The indexes/results are
rebuilt on demand when an owner returns. This preserves conversations, models,
workspaces, provider configuration, and embedded model parts.

On container startup, before any owner workers start, the gateway removes legacy
duplicated discovery/Jev caches to reclaim space for the shared indexes. It does
not migrate private query scores into shared storage. The first reference search
after deployment or eviction can take longer while the public indexes rebuild.
Seven-day retention bounds idle cache growth; it is not a hard 5 GB limit on
active references, private workspaces, or output files.

## Upgrading and attribution

The quick-preview integration pins the immutable head of
[Nova fork PR #5](https://github.com/jjohnson5253/ldraw-nova-docker/pull/5), including
selected-revision verification and complete Claude usage accounting after preview
interruption. The API requires `preview_build_version: 1` in addition to the cost,
palette, and build-review capabilities before admitting new All parts jobs.
Deploy the rebuilt Nova runtime together with this API/frontend after applying
the new generation-mode migration. No production merge or deployment is performed
by preparing these changes.

For the repeatable shared staging workflow and per-PR Vercel connection, see
[Testing Nova through BrickBuilder staging](nova-staging.md). Run
`npm run nova:pin-staging` on a feature branch to select both forks' latest staging
commits and regenerate the deployment recipe before opening the consumer PR.

The two repository pins are in `backend/setup_nova.cjs`:

- https://github.com/jjohnson5253/ldraw-nova, AGPL-3.0, forked from anteloc/ldraw-nova.
- https://github.com/jjohnson5253/ldraw-nova-docker, forked from anteloc/ldraw-nova-docker,
  including its runtime dependencies.

The pins select compatible immutable revisions merged into the forks' `staging`
branches. Updates are taken from the forks so changes merged there can flow into
BrickBuilder.

Update the compatible pins, run setup, verify the adapter contracts and a real
Nova generation/edit, then rebuild and deploy the service image. Clean managed
checkouts update in place. Local source changes are preserved by refusing the
update. Session volumes are independent of source checkouts. Nova's new agent
behavior, manuals, tools and renderer arrive through the dependency update;
they do not need to be rewritten in BrickBuilder.

Preserve upstream licenses, attribution and corresponding-source obligations
when distributing/hosting the combined integration. Source models and official
LDraw parts retain their own attribution and licensing. Nova's checks and
renders are review evidence; generated models still need human build review.
