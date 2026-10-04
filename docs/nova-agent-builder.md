# Nova mode

Nova mode runs the real upstream Nova agent. BrickBuilder supplies the existing
composer, generation jobs, notifications, viewer and saved model collection.
Nova owns prompts, tools, provider conversations, script execution, search,
validation, rendering and publication. Follow-up edits continue the same Nova
conversation and workspace.

## Local setup

Install Docker Desktop, then run:

```sh
npm install
npm run setup:nova
npm start
```

`setup:nova` fetches two immutable upstream revisions into ignored
`backend/.nova/toolkit` and `backend/.nova/web`. It builds the upstream Dockerfile
with the toolkit as its additional build context. The only additions are the
private tenant gateway and artifact export adapter in `backend/nova-service`.
LeoCAD, the official parts library, Jev, provider SDKs and Nova's sandbox come
from the upstream image. The first build can take several minutes and several
GB of disk space.

The runtime listens on `127.0.0.1:8778`; set `NOVA_SERVICE_PORT` before setup to
choose another port. The generated `connection.json` and `service.env` contain
a random server token and are owner-readable and ignored by Git. They are never
sent to the browser. Setup preserves session data and the protected provider
configuration across rebuilds. It replaces only this installation's managed
container, whose name is derived from the installation directory.

Open **Full set agent** on the BrickBuilder landing page. The selected API key
is forwarded from the backend to the private Nova provider configuration.
**Local provider connections** signs into Nova's own provider session once the
runtime is installed. OpenAI uses Nova's device login; Claude uses Nova's SDK
browser login and optional manual code. Native connections are localhost-only.
No host provider credential directory is mounted into the runtime.

The generation adapter selects Nova's **Agent** mode with **Full** tool
permissions so builds run automatically in their isolated workspace. Nova's
own step limit and model defaults apply. BrickBuilder retains its overall job
time limit (`NOVA_TIMEOUT_SECONDS`, default 1800, allowed 60–7200 seconds).
Describe scale and part preferences in the prompt. There are no separate
BrickBuilder planning prompts, tool schemas, render loop or acceptance rules.

Set `TYPESAFE_API_KEY` in the ignored backend environment to configure Jev in
Nova's protected settings. Nova chooses its own search workflow and fallback.
Other BrickBuilder generation modes and fal connections remain available.

## Saved generations and edits

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

The private `generation-output` bucket retains:

- `nova-session.json`: tenant/session identity, published model identity, model
  connection settings and exact upstream source revisions; no credentials.
- `nova-source.zip`: the original MPD, flat export, preview, original Nova BOM,
  conversation and bounded workspace source/review files.

These files are read only through owner-checked backend operations. Public model
links do not expose Nova sessions, conversations or private source archives.
No new public database columns or migration are needed. Cancellation and timeout
also cancel the active Nova turn; its durable session remains available.
Old generations from the previous PR implementation retain source downloads but
do not have a resumable Nova session.

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

Build the deployment image with the same installer:

```sh
node scripts/nova.cjs --prepare
docker build --platform linux/amd64 \
  --build-context nova=backend/.nova/toolkit \
  --build-arg MPD2GLB_SHA256=381fb275c9f974820620ef4e4ec8b5be84ea8306a9f1ccd95bc75beaa8139f34 \
  -f backend/.nova/Dockerfile.service -t your-registry/brickbuilder-nova:VERSION \
  backend/.nova/web
```

The mpd2glb checksum build argument corrects the pinned upstream Dockerfile's
v0.9.1 artifact checksum, verified against that release's GitHub digest. The
upstream application source remains unchanged. The `Nova runtime image` GitHub
workflow builds the same image and publishes commit-tagged images on main,
staging or explicit dispatch. PR builds validate without publishing.

Set the selected provider API key on the BrickBuilder API. The adapter provisions
it only in that owner's protected Nova config. Native account connections remain
local. Each service replica needs the persistent volumes for the sessions it
serves; route a session consistently to its volume. `NOVA_MAX_WORKERS` bounds
concurrent resident workers (default 16); capacity errors fail visibly instead
of bypassing the isolation boundary.

## Upgrading and attribution

The two repository pins are in `backend/setup_nova.cjs`:

- https://github.com/anteloc/ldraw-nova, AGPL-3.0.
- https://github.com/anteloc/ldraw-nova-docker, including its runtime dependencies.

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
