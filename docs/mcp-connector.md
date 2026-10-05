# BrickBuilder AI for ChatGPT and Claude

This connector runs the existing `/llmToBricks` pipeline. It adds a remote,
authenticated Streamable HTTP MCP endpoint at `/mcp` to the Railway backend.
It is disabled until configured. A PR or plugin package alone does not make
the connector live or publish it in either platform's directory.

## What the tools do

| Tool | Purpose | Credits |
| --- | --- | --- |
| `generate_lego_model` | Start an AI build from a description; choose an existing supported model and 12–64 stud size hint | 1 after successful AI generation |
| `edit_lego_model` | Edit the signed-in user's saved voxels into a new generation; preserve the original | 1 after successful AI generation |
| `get_lego_model` | Read progress; return preview, brick count, LDraw download, and parts-list CSV when complete | 0 |
| `get_brick_builder_account` | Identify the connected account and available credits | 0 |

The normal default design mode opens a Claude/OpenAI tool conversation, builds
colored stud-grid shapes, validates geometry, renders a preview, and feeds
diagnostics back through correction/review rounds. Accepted voxels then go
through `glb2brick` / `voxel2brick`; the normal pipeline saves LDraw, parts CSV,
editable source voxels, conversion diagnostics, and a preview. LDraw packing
is checked before the job is marked complete. The website builds instructions
and provides interactive viewing and editing. Geometry diagnostics are not a
physical buildability certification.

MCP calls start the existing background job and return its ID immediately.
Clients should wait about 10 seconds before `get_lego_model`, reuse the same
ID until completion or failure, and never start another build just to poll.
The tools return JSON in both text and `structuredContent`, with input/output
schemas, OAuth metadata, and explicit read/write annotations. No custom chat
widget is needed; the model link opens the existing 3D viewer on the exact
generation. This first version accepts text descriptions; image references
remain supported by the existing website/API rather than accepting arbitrary
remote image URLs through MCP.

## Stage and activate

1. Deploy this branch's backend and frontend to staging. Apply
   `supabase/migrations/20260930000001_mcp_oauth.sql` to that environment's
   Supabase project. This creates an administrator-only client binding table
   and a hook function; applying it does not activate the hook.
2. Enable **Authentication → OAuth Server** in Supabase. Set the project's
   Site URL to the matching frontend and its authorization path to
   `/oauth/consent`. The page preserves the request through existing password,
   Google, or email sign-in, then displays the client, permissions, and cost.
   Approval and denial use Supabase's OAuth methods; the app does not implement
   its own authorization codes or refresh tokens.
   If staging and production share one Supabase project, preserve the existing
   production Site URL and deploy the consent route there before connecting
   platform accounts. The OAuth authorization path is project-wide; separate
   client registrations and resource bindings still isolate the two backends.
3. Register separate OAuth clients for ChatGPT and Claude. Use the exact
   callback URI shown by each platform, authorization-code + PKCE (`S256`),
   refresh tokens, and the `email` scope. Enter the issued client ID and secret
   in the platform's connector configuration. Do not put secrets in this repo
   or an MCP tool argument. Use predefined clients; dynamic registration is
   not required for this deployment.
4. Insert each client ID with the corresponding canonical resource URL. IDs
   are identifiers, not secrets. Example for staging:

   ```sql
   insert into public.mcp_oauth_clients (client_id, resource_url) values
     ('<chatgpt-oauth-client-id>', 'https://brickai-backend-staging.up.railway.app/mcp'),
     ('<claude-oauth-client-id>', 'https://brickai-backend-staging.up.railway.app/mcp');
   ```

5. In Supabase **Authentication → Hooks**, select
   `public.mcp_access_token_hook` as the custom access token hook. If the
   project already has a hook, incorporate this function's resource-binding
   logic into it instead of replacing unrelated claims. Ordinary web sessions
   and unregistered OAuth clients keep their original claims. Registered
   connector access tokens receive the exact MCP URL as `aud` and `email` as
   `scope`, including on refresh. Use separate client registrations and
   resource bindings for staging and production.
6. Set these variables on the corresponding Railway backend and restart:

   ```dotenv
   MCP_ENABLED=true
   MCP_PUBLIC_URL=https://brickai-backend-staging.up.railway.app/mcp
   MCP_WEBSITE_URL=https://brickbuilderai-git-staging-jjohnson3700team.vercel.app
   MCP_OAUTH_CLIENT_IDS=<chatgpt-oauth-client-id>,<claude-oauth-client-id>
   ```

   Existing `SUPABASE_URL`, service-role key, and generation provider keys
   remain necessary. `SUPABASE_JWT_SECRET` verifies legacy HS256 signatures;
   RS256/ES256 tokens use the project's JWKS. The connector also verifies
   issuer, resource audience, expiration, identity, email scope, account role,
   and the approved client ID. Browser tokens, guest sessions, and developer
   API keys cannot bypass MCP authentication. Configure the exact public
   hostname; host/origin checks reject other hosts and unapproved origins.
7. Verify discovery with a GET to
   `/.well-known/oauth-protected-resource/mcp`. It must advertise the same
   resource URL and Supabase issuer (`https://<project>.supabase.co/auth/v1`).
   An unauthenticated POST to `/mcp` must return `401` and a
   `WWW-Authenticate` header pointing to that metadata. When disabled, `/mcp`
   returns `503`; an enabled but incomplete configuration fails at startup.
8. Use MCP Inspector's Streamable HTTP and OAuth modes to run initialization,
   list all four tools, sign in, build a model, poll it to completion, inspect
   the preview/downloads, and edit it. Sign in as a second account and confirm
   it cannot read or edit the first account's generation. Check an account
   without credits and an expired/revoked connection. Reconnect and confirm
   the same account identity and successful refresh.

The server enforces owner-only reads even for community models and returns
only selected result fields. Provider errors and private design/reasoning
snapshots are not sent to the host model. Generation uses the existing credit
checks/deductions and PostHog tracking. MCP reads do not consume anonymous
quotas or credits. Existing background jobs are process-local; a backend
restart can interrupt a job, just as for the website.
The read tool reports a missing heartbeat after 30 seconds as a failed build,
so clients do not keep polling an interrupted job indefinitely.

## Connect the clients

For ChatGPT, enable developer mode, register the public HTTPS `/mcp` endpoint
with OAuth and the predefined client credentials, connect an account, and
enable the connector for a test conversation. Follow the current
[OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt).
The same server is usable through the OpenAI API's remote MCP integration.
Public predefined clients can use PKCE with token endpoint authentication
`none`, without a client secret. If the project still signs with HS256,
disable optional OpenID Connect in ChatGPT's advanced OAuth settings and
request `email`; Supabase requires asymmetric signing for the `openid` scope.

For Claude, add a custom connector with the same endpoint and its own OAuth
client credentials, connect an account, and enable it for a conversation.
Remote connections originate from Anthropic's cloud, so the endpoint must
be publicly reachable. Follow the
[Claude custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

`plugins/brickbuilder/` contains a portable plugin manifest and MCP
configuration targeting the intended production Railway URL. Its URL becomes
usable after production promotion and configuration; it is not a deployment
status claim. For a staging package, change the packaged endpoint to the
staging URL before installation. For ChatGPT's registered-server package
mapping, obtain the real `plugin_asdk_app...` ID from developer mode and add
the `.app.json` mapping described in the
[packaging guide](https://developers.openai.com/plugins/build/plugins).
Do not invent a registration ID or use a legacy `ai-plugin.json` manifest.

## Discovery and publication

Tool descriptions, server instructions, and package metadata mention LEGO,
brick models, LDraw, previews, and parts lists so a connected model can match
requests such as “build me a LEGO castle.” A model can only choose a tool it
has access to; hosting `/mcp` cannot force every ChatGPT/Claude conversation
to use it.

After production promotion, OAuth configuration, and real-account tests:

- Submit the ChatGPT integration/package using OpenAI's
  [submission process](https://developers.openai.com/plugins/deploy/submission).
  Supply the real public endpoint, account access for review, app metadata,
  privacy/support details, and evidence from the tests below.
- Submit the connector through Anthropic's
  [Connectors Directory](https://claude.com/connectors) submission process
  for broader discovery. Custom connector access works before directory
  approval for users who configure it.

Suggested listing text: **Turn ideas into LEGO brick models and parts lists.**
The workflow provides AI design feedback, geometry checks, a 3D preview,
editable saved models, and downloadable LDraw/CSV artifacts.

## Evaluation prompts

| Prompt | Expected behavior |
| --- | --- |
| “Build me a red LEGO castle with two towers.” | Generate once, keep the ID, report pending status honestly, then retrieve files |
| “Make a brick-built lighthouse about 24 studs wide.” | Generate with a matching size hint |
| “Make the roof blue on the model we just created.” | Edit that generation; retrieve the new ID; preserve original |
| “Is my model ready yet?” | Poll the existing ID without starting a new build |
| “Show my parts list and preview.” | Return completed model artifacts and viewer link |
| “How many credits do I have?” | Query the connected account |
| “What is the history of LEGO?” | Answer normally; no generation call |
| Another account's private generation ID | Safe not-found error; no artifact or reasoning disclosure |
| Invalid model/size/prompt, no credits, expired token | Validation/credit/auth error; no generation bypass |

Record actual end-to-end client results after deployment. The automated suite
exercises HTTP MCP initialization/discovery/calls, JWT verification, owner
access, input validation, safe errors, consent decisions/login redirects, and
the actual token-hook SQL in local Postgres. It does not claim platform
directory approval or a live OAuth round trip against an unconfigured tenant.

References: [OpenAI MCP server guide](https://developers.openai.com/plugins/build/mcp-server),
[OpenAI authentication](https://developers.openai.com/plugins/build/auth),
[Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication),
[Supabase OAuth setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started).
