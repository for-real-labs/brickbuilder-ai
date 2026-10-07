#!/usr/bin/env node
/**
 * Replaces `vite build` as the Vercel build command.
 *
 * When Vercel builds a *preview* deployment for a pull request, Railway (if PR
 * Environments are enabled) spins up a matching temporary backend for that
 * same PR. This script looks up that backend's public domain via the Railway
 * GraphQL API and runs `vite build` with VITE_API_MODE/VITE_RAILWAY_API_URL_STAGING
 * overridden directly in that build process's environment, so the preview
 * frontend talks to the PR's own backend instead of the shared `staging`
 * Railway service.
 *
 * A `.env.local` file (or any other env file) can't be used for this: Vite
 * gives already-set process.env values priority over .env* file contents, and
 * Vercel already has VITE_RAILWAY_API_URL_STAGING configured as a project env
 * var for the persistent `staging` backend, so a file-based override would
 * always lose. Spawning `vite build` with an explicit env object is the only
 * way to actually win that precedence.
 *
 * Public GitHub branch builds discover their PR even when Vercel omits its ID.
 * They wait for the matching backend commit and use Railway's authenticated bot
 * deployment link. A failed or unavailable PR backend stops the preview build.
 * Non-PR branches keep their configured backend. The GraphQL lookup below
 * supports explicit PR builds without GitHub repository metadata.
 *
 * Required Vercel project env vars for this to activate:
 *   RAILWAY_API_TOKEN            - Railway account or workspace token
 *   RAILWAY_PROJECT_ID           - the Railway project containing the backend
 *   RAILWAY_BACKEND_SERVICE_NAME - name of the backend service in Railway
 *                                  (defaults to "brickai-backend"; only needed
 *                                  if you rename the Railway service)
 *
 * Optional tuning:
 *   RAILWAY_PREVIEW_MAX_ATTEMPTS  - lookup attempts before fallback (default 30)
 *   RAILWAY_PREVIEW_RETRY_DELAY_MS - delay between attempts in ms (default 5000)
 */
import { spawnSync } from 'node:child_process';
import { prerenderLegalPages } from './legal-prerender.mjs';
import { resolveGitHubPreviewBackend } from './github-preview.mjs';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  resolveRailwayPreviewBackend,
} from './railway-preview.mjs';

const RAILWAY_API_URL = 'https://backboard.railway.com/graphql/v2';

function log(message) {
  console.log(`[build] ${message}`);
}

async function runViteBuild(env) {
  const result = spawnSync('npx', ['vite', 'build'], {
    stdio: 'inherit',
    env: {
      ...env,
      VITE_CHANGE_REQUEST_BRANCH: process.env.VERCEL_GIT_COMMIT_REF || 'main',
      VITE_CHANGE_REQUEST_SHA: process.env.VERCEL_GIT_COMMIT_SHA || '',
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  try {
    await prerenderLegalPages();
  } catch (error) {
    console.error('[build] Legal page rendering failed:', error);
    process.exit(1);
  }
}

function readPositiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;

  log(`${name} must be a positive integer; using ${fallback}.`);
  return fallback;
}

async function main() {
  const githubBackend = await resolveGitHubPreviewBackend({ env: process.env, log });
  if (githubBackend) {
    log(`Resolved PR backend to ${githubBackend}; building with it.`);
    await runViteBuild({
      ...process.env, VITE_API_MODE: 'railway_staging', VITE_RAILWAY_API_URL_STAGING: githubBackend,
    });
    return;
  }
  const prId = process.env.VERCEL_GIT_PULL_REQUEST_ID;
  const vercelEnv = process.env.VERCEL_ENV;

  if (vercelEnv !== 'preview' || !prId) {
    log('Not a PR preview build; skipping Railway PR backend lookup.');
    await runViteBuild(process.env);
    return;
  }

  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const serviceName = process.env.RAILWAY_BACKEND_SERVICE_NAME || 'brickai-backend';

  if (!token || !projectId) {
    log(
      'RAILWAY_API_TOKEN and/or RAILWAY_PROJECT_ID are not set; skipping. ' +
        'Set them as Vercel project env vars to enable per-PR backend resolution.'
    );
    await runViteBuild(process.env);
    return;
  }

  const query = `
    query ProjectEnvironmentsAndServices($projectId: String!) {
      project(id: $projectId) {
        environments {
          edges { node { id name } }
        }
        services {
          edges {
            node {
              id
              name
              serviceInstances {
                edges {
                  node {
                    environmentId
                    domains {
                      serviceDomains { domain }
                      customDomains { domain }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  async function loadProject() {
    const response = await fetch(RAILWAY_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { projectId } }),
    });
    const json = await response.json();
    if (!response.ok || json.errors) {
      throw new Error(
        `Railway API request failed: ${response.status} ${JSON.stringify(json.errors)}`,
      );
    }

    if (!json?.data?.project) {
      throw new Error('Railway API response missing project data.');
    }
    return json.data.project;
  }

  const maxAttempts = readPositiveInteger(
    process.env.RAILWAY_PREVIEW_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    'RAILWAY_PREVIEW_MAX_ATTEMPTS',
  );
  const retryDelayMs = readPositiveInteger(
    process.env.RAILWAY_PREVIEW_RETRY_DELAY_MS,
    DEFAULT_RETRY_DELAY_MS,
    'RAILWAY_PREVIEW_RETRY_DELAY_MS',
  );

  const backendUrl = await resolveRailwayPreviewBackend({
    loadProject,
    prId,
    serviceName,
    maxAttempts,
    retryDelayMs,
    log,
  });
  if (!backendUrl) {
    await runViteBuild(process.env);
    return;
  }

  log(`Resolved PR backend to ${backendUrl}; building with it.`);
  await runViteBuild({
    ...process.env,
    VITE_API_MODE: 'railway_staging',
    VITE_RAILWAY_API_URL_STAGING: backendUrl,
  });
}

main().catch((err) => {
  log(`Build stopped: ${err.message}. A PR preview must use its matching backend.`);
  process.exit(1);
});
