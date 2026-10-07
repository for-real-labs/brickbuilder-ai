import { describe, expect, it, vi } from 'vitest';

import {
  inspectRailwayProject,
  resolveRailwayPreviewBackend,
} from '../scripts/railway-preview.mjs';
import { railwayBackendFromComments, resolveGitHubPreviewBackend } from '../scripts/github-preview.mjs';

function railwayProject({
  environmentName,
  domain,
  serviceName = 'brickai-backend',
}: {
  environmentName?: string;
  domain?: string;
  serviceName?: string;
}) {
  const environmentId = 'environment-id';
  return {
    environments: {
      edges: environmentName
        ? [{ node: { id: environmentId, name: environmentName } }]
        : [],
    },
    services: {
      edges: [
        {
          node: {
            name: serviceName,
            serviceInstances: {
              edges: environmentName
                ? [{
                    node: {
                      environmentId,
                      domains: {
                        serviceDomains: domain ? [{ domain }] : [],
                        customDomains: [],
                      },
                    },
                  }]
                : [],
            },
          },
        },
      ],
    },
  };
}

describe('Railway preview backend resolution', () => {
  it('matches Railway environment names by PR suffix', () => {
    expect(
      inspectRailwayProject(
        railwayProject({
          environmentName: 'brickbuilderai-pr-86',
          domain: 'preview.example.com',
        }),
        '86',
        'brickai-backend',
      ),
    ).toEqual({ status: 'resolved', backendUrl: 'https://preview.example.com' });
  });

  it('waits for the PR environment and domain to become available', async () => {
    const loadProject = vi
      .fn()
      .mockResolvedValueOnce(railwayProject({}))
      .mockResolvedValueOnce(railwayProject({ environmentName: 'pr-86' }))
      .mockResolvedValueOnce(
        railwayProject({ environmentName: 'pr-86', domain: 'preview.example.com' }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      resolveRailwayPreviewBackend({
        loadProject,
        prId: '86',
        serviceName: 'brickai-backend',
        maxAttempts: 3,
        retryDelayMs: 10,
        sleep,
      }),
    ).resolves.toBe('https://preview.example.com');
    expect(loadProject).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('falls back after the bounded retry window expires', async () => {
    const loadProject = vi.fn().mockResolvedValue(railwayProject({}));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    await expect(
      resolveRailwayPreviewBackend({
        loadProject,
        prId: '86',
        serviceName: 'brickai-backend',
        maxAttempts: 3,
        retryDelayMs: 10,
        sleep,
        log,
      }),
    ).resolves.toBeNull();
    expect(loadProject).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining('Railway was not ready after 3 attempts'),
    );
  });

  it('does not retry a missing backend service', async () => {
    const loadProject = vi.fn().mockResolvedValue(
      railwayProject({ serviceName: 'different-service' }),
    );
    const sleep = vi.fn();

    await expect(
      resolveRailwayPreviewBackend({
        loadProject,
        prId: '86',
        serviceName: 'brickai-backend',
        sleep,
      }),
    ).resolves.toBeNull();
    expect(loadProject).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

const previewEnv = {
  VERCEL_ENV: 'preview', VERCEL_GIT_REPO_OWNER: 'builder', VERCEL_GIT_REPO_SLUG: 'bricks',
  VERCEL_GIT_COMMIT_REF: 'feature/notifications', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
};
const deploymentComment = {
  user: {login: 'railway-app[bot]', type: 'Bot'},
  body: '<!-- railway-project-id="project" -->\n| brickai-backend | ✅ Success | [Web](https://backend-pr-205.up.railway.app) | now |',
};
const json = (data: unknown) => ({ok: true, json: async () => data});

it('finds the PR for a branch deployment and waits for its matching backend commit', async () => {
  const fetchImpl = vi.fn().mockResolvedValueOnce(json([{
    number: 205, state: 'open', head: {ref: previewEnv.VERCEL_GIT_COMMIT_REF, repo: {owner: {login: 'builder'}}},
  }])).mockResolvedValueOnce(json({statuses: [{context: 'lego stuff - brickai-backend', state: 'pending'}]}))
    .mockResolvedValueOnce(json({statuses: [{context: 'lego stuff - brickai-backend', state: 'success'}]}))
    .mockResolvedValueOnce(json([deploymentComment]));
  const sleep = vi.fn();
  await expect(resolveGitHubPreviewBackend({env: previewEnv, fetchImpl, sleep, maxAttempts: 2}))
    .resolves.toBe('https://backend-pr-205.up.railway.app');
  expect(fetchImpl.mock.calls[0][0]).toContain('head=builder%3Afeature%2Fnotifications');
  expect(fetchImpl.mock.calls[1][0]).toContain('/commits/' + previewEnv.VERCEL_GIT_COMMIT_SHA + '/status');
  expect(sleep).toHaveBeenCalledOnce();
});

it.each(['failure', 'error', 'pending'])('does not build against shared staging when the PR backend is %s', async state => {
  const fetchImpl = vi.fn().mockResolvedValue(json({statuses: [{context: 'lego stuff - brickai-backend', state}]}));
  await expect(resolveGitHubPreviewBackend({
    env: {...previewEnv, VERCEL_GIT_PULL_REQUEST_ID: '205'}, fetchImpl, maxAttempts: 1,
  })).rejects.toThrow(state === 'pending' ? 'not ready' : 'deployment failed');
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('keeps production and branches without a PR on their configured backend', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(json([]));
  await expect(resolveGitHubPreviewBackend({env: {...previewEnv, VERCEL_ENV: 'production'}, fetchImpl})).resolves.toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(resolveGitHubPreviewBackend({env: previewEnv, fetchImpl})).resolves.toBeNull();
});

it('accepts only unambiguous successful Railway bot links for the selected service and project', () => {
  expect(railwayBackendFromComments([deploymentComment], 'brickai-backend', 'project'))
    .toBe('https://backend-pr-205.up.railway.app');
  expect(railwayBackendFromComments([deploymentComment], 'nova-production', 'project')).toBeNull();
  expect(railwayBackendFromComments([deploymentComment], 'brickai-backend', 'other')).toBeNull();
  for (const link of ['https://evil.example', 'http://test.up.railway.app', 'https://user:secret@test.up.railway.app']) {
    expect(railwayBackendFromComments([{...deploymentComment,
      body: deploymentComment.body.replace('https://backend-pr-205.up.railway.app', link),
    }], 'brickai-backend')).toBeNull();
  }
  expect(railwayBackendFromComments([{...deploymentComment, user: {login: 'intruder', type: 'User'}}], 'brickai-backend')).toBeNull();
  expect(railwayBackendFromComments([deploymentComment, {...deploymentComment,
    body: deploymentComment.body.replace('backend-pr-205', 'other'),
  }], 'brickai-backend')).toBeNull();
});
