# Testing Nova through BrickBuilder staging

Use the existing shared staging stack for repeatable testing: Vercel preview
frontend → Railway staging backend → Railway staging Nova. These services already
exist. Vercel Preview uses `VITE_API_MODE=railway_staging` and
`VITE_RAILWAY_API_URL_STAGING=https://brickai-backend-staging.up.railway.app`.

## Updating Nova

1. Push, validate and merge the Nova changes into the applicable fork's `staging`
   branch. Both forks must remain compatible.
2. On a BrickBuilder feature branch, run from the repository root:

   ```sh
   npm run nova:pin-staging
   ```

   This resolves both Nova staging branches to immutable commit hashes, updates
   `backend/setup_nova.cjs`, and regenerates `backend/nova-service/Dockerfile`.
   If either branch cannot be resolved or preparation fails, the tracked pins and
   deployment recipe remain at their previous values. It does not push or merge.
3. Review and commit those two files, validate the change, and open a BrickBuilder
   PR targeting `staging`. Merge that PR when ready for shared staging testing.
4. Wait for Railway's staging `nova` and `brickai-backend` deployments to finish.
   They build from BrickBuilder staging; a Nova fork push alone does not update
   these services. No supplier catalog is added to either Nova fork.
5. Open the [BrickBuilder staging frontend](https://brickbuilderai-git-staging-jjohnson3700team.vercel.app)
   or a Vercel branch preview using the shared staging API, and select **All parts**.

`npm run update:nova` builds/starts the locally configured pins. It does not select
the latest staging commits; `nova:pin-staging` performs that separate step.

## Testing a BrickBuilder PR before merging

Railway can create a separate environment for a BrickBuilder PR, with the matching
backend and Nova. In Railway, open that PR environment, select `brickai-backend`,
and copy its **Settings → Networking → Public Networking** HTTPS domain. Confirm
its backend and Nova deployments are ready. The backend uses Nova's private
address within its own Railway environment.

In Vercel's `brickbuilderai` project, open **Settings → Environment Variables** and
add a branch-specific Preview override:

```dotenv
VITE_RAILWAY_API_URL_STAGING=https://<that-PR-backend-domain>
```

Select **Preview** and the exact BrickBuilder PR branch. Keep
`VITE_API_MODE=railway_staging`, which is already set for Preview. Redeploy that
branch after saving: Vite embeds these values at build time. This leaves other
previews using shared staging. Use the public backend HTTPS domain here; Nova's
private address and service token belong only in Railway, never in Vercel client
variables.

For PR #206, the branch is `codex/nova-brickwith-parts` and the Railway environment
is `brickbuilder-ai-pr-206`. PR environments are temporary, so remove the branch
override when that environment is removed and redeploy before reusing the preview.

References: [Vercel branch-specific Preview variables](https://vercel.com/docs/environment-variables),
[Vercel redeploy requirement](https://vercel.com/kb/guide/how-to-add-vercel-environment-variables),
[Railway PR environments](https://docs.railway.com/environments).
