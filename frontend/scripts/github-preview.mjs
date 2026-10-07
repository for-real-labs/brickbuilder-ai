// Vercel branch builds can omit VERCEL_GIT_PULL_REQUEST_ID. Public Railway
// deployment comments let those builds select their PR backend without secrets.
export function railwayBackendFromComments(comments, serviceName, projectId) {
  const domains = new Set();
  for (const comment of comments) {
    if (comment.user?.login !== 'railway-app[bot]' || comment.user?.type !== 'Bot') continue;
    if (projectId && !comment.body?.includes(`railway-project-id="${projectId}"`)) continue;
    for (const line of (comment.body || '').split('\n')) {
      const cells = line.split('|').map(cell => cell.trim());
      if (cells[1] !== serviceName || !cells[2]?.includes('✅ Success')) continue;
      const link = cells[3]?.match(/\[Web\]\((https:\/\/[^)]+)\)/)?.[1];
      if (!link) continue;
      try {
        const url = new URL(link);
        if (url.hostname.endsWith('.up.railway.app') && !url.username && !url.password
            && !url.port && url.pathname === '/' && !url.search && !url.hash) domains.add(url.origin);
      } catch { /* Ignore malformed deployment links. */ }
    }
  }
  return domains.size === 1 ? [...domains][0] : null;
}

export async function resolveGitHubPreviewBackend({
  env, fetchImpl = fetch, sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  maxAttempts = 30, retryDelayMs = 10_000, log = () => {},
}) {
  if (env.VERCEL_ENV !== 'preview') return null;
  const owner = env.VERCEL_GIT_REPO_OWNER, repo = env.VERCEL_GIT_REPO_SLUG;
  const branch = env.VERCEL_GIT_COMMIT_REF;
  if (!/^[\w.-]+$/.test(owner || '') || !/^[\w.-]+$/.test(repo || '') || !branch) return null;
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const get = async path => {
    const response = await fetchImpl(base + path, {
      headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub preview lookup failed (${response.status})`);
    return response.json();
  };
  let prId = env.VERCEL_GIT_PULL_REQUEST_ID;
  if (!/^[1-9]\d*$/.test(prId || '')) {
    const pulls = await get(`/pulls?state=open&head=${encodeURIComponent(owner + ':' + branch)}&per_page=100`);
    const matching = pulls.filter(pull => pull.state === 'open' && pull.head?.ref === branch
      && pull.head?.repo?.owner?.login?.toLowerCase() === owner.toLowerCase());
    if (matching.length !== 1 || !Number.isSafeInteger(matching[0].number)) return null;
    prId = String(matching[0].number);
  }
  const serviceName = env.RAILWAY_BACKEND_SERVICE_NAME || 'brickai-backend';
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('PR preview is missing its commit SHA');
  log(`Selecting the Railway backend for PR ${prId} at ${sha.slice(0, 7)}.`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status = await get(`/commits/${sha}/status`);
    const backend = status.statuses?.find(item => item.context?.endsWith(' - ' + serviceName));
    if (backend?.state === 'failure' || backend?.state === 'error') {
      throw new Error('The PR backend deployment failed. Fix it before rebuilding this preview.');
    }
    if (backend?.state === 'success') {
      const comments = await get(`/issues/${prId}/comments?per_page=100&sort=created&direction=desc`);
      const url = railwayBackendFromComments(comments, serviceName, env.RAILWAY_PROJECT_ID);
      if (url) return url;
    }
    if (attempt < maxAttempts) await sleep(retryDelayMs);
  }
  throw new Error('The PR backend is not ready yet. Rebuild this preview when its deployment succeeds.');
}
