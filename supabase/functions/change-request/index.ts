import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  isChangeBranch, parseGitHubAgentCompletion,
  matchesChangePreview, parseGitHubVercelPreview, parseTestFlightReady, previewAuthLink,
  previewEmailMessage, pullReadyRequest, taskBranchName, taskPullNumber,
  testFlightEmailMessage, validateChange,
} from '../_shared/change-request-spec.js';
import { purgeChangeRequestScreenshots } from '../_shared/change-request-storage.js';

const url = Deno.env.get('SUPABASE_URL')!;
const serviceKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
  || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(url, serviceKey);
const repo = Deno.env.get('CHANGE_REQUEST_GITHUB_REPO') || 'jjohnson5253/brickbuilderai';
const repoPath = `/repos/${repo}`;
const bucket = 'change-request-images';
const ghHeaders = () => ({
  Authorization: `Bearer ${Deno.env.get('CHANGE_REQUEST_GITHUB_TOKEN') || ''}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'Content-Type': 'application/json',
});

function response(body: unknown, status = 200, origin = '') {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-change-request-event-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
    'Cache-Control': 'no-store',
  } });
}

function allowedOrigin(request: Request) {
  const value = request.headers.get('origin') || '';
  if (!value) return '';
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' &&
      ((u.hostname === 'brickbuilder.ai' || u.hostname === 'www.brickbuilder.ai') || u.hostname.endsWith('.vercel.app')))
      return value;
    if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))
      return value;
  } catch { /* bad origin */ }
  return null;
}

async function github(path: string, method = 'GET', body?: unknown) {
  if (!Deno.env.get('CHANGE_REQUEST_GITHUB_TOKEN')) throw new Error('GitHub integration is not configured.');
  const res = await fetch(`https://api.github.com${path}`, {
    method, headers: ghHeaders(), body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} failed (${res.status}).`);
  return res.json();
}

async function mergePreviewPull(pullNumber: number, sha: string) {
  const methods = ['squash', 'merge', 'rebase'] as const;
  let mergeRejected = false;
  for (const merge_method of methods) {
    try {
      await github(`${repoPath}/pulls/${pullNumber}/merge`, 'PUT', { sha, merge_method });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/GitHub PUT failed \(405\)\./.test(error.message)) throw error;
      mergeRejected = true;
    }
  }
  if (mergeRejected) {
    throw new Error('GitHub could not merge this PR. Resolve merge requirements or conflicts, then try again.');
  }
}

async function sendMail(to: string, subject: string, lines: string[]) {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email integration is not configured.');
  const dest = Deno.env.get('EMAIL_OVERRIDE') || to;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: Deno.env.get('EMAIL_FROM') || 'BrickBuilder <noreply@brickbuilder.ai>',
      to: dest, subject, text: lines.join('\n'),
    }),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status}).`);
}

async function account(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!token) throw new Error('Sign in to request a change.');
  const { data: { user }, error } = await db.auth.getUser(token);
  if (error || !user?.email) throw new Error('Sign in to request a change.');
  const { data: grant, error: grantError } = await db.from('change_request_access')
    .select('user_id').eq('user_id', user.id).maybeSingle();
  if (grantError) throw grantError;
  const { data: emailGrant, error: emailGrantError } = await db
    .from('change_request_email_access')
    .select('email').eq('email', user.email.trim().toLowerCase()).maybeSingle();
  if (emailGrantError) throw emailGrantError;
  if (!grant && !emailGrant) {
    throw new Error('Your account does not have change-request access.');
  }
  return { id: user.id, email: user.email };
}

async function storeImages(id: string, files: File[]) {
  const links = [];
  const paths = [];
  try {
    for (const [index, file] of files.entries()) {
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `${id}/${index}-${crypto.randomUUID()}.${ext}`;
      const { error } = await db.storage.from(bucket).upload(path, file, {
        contentType: file.type, upsert: false,
      });
      if (error) throw error;
      paths.push(path);
      const { data, error: signError } = await db.storage.from(bucket).createSignedUrl(path, 4 * 3600);
      if (signError || !data?.signedUrl) throw signError || new Error('Could not sign screenshot.');
      links.push(data.signedUrl);
    }
  } catch (error) {
    await purgeChangeRequestScreenshots(db, bucket, { id, screenshots: paths });
    throw error;
  }
  return { paths, links };
}

async function submit(request: Request, user: { id: string; email: string }, origin: string) {
  const form = await request.formData();
  const description = String(form.get('description') || '');
  const files = form.getAll('screenshots').filter((v): v is File => v instanceof File);
  validateChange(description, files);
  if (form.get('no_phi') !== 'yes') throw new Error('Confirm that the description and images contain no private or sensitive information.');
  const branch = String(form.get('branch') || 'main');
  const requestId = String(form.get('request_id') || '');
  const requestedTarget = String(form.get('target') || 'web');
  if (!['web', 'ios'].includes(requestedTarget)) throw new Error('Unknown change-request target.');
  let row: Record<string, unknown>;
  if (branch !== 'main') {
    if (!isChangeBranch(branch)) throw new Error('Changes must use a separate branch created from staging.');
    if (!requestId) throw new Error('Open the request from its preview link.');
    const { data } = await db.from('change_requests').select('*')
      .eq('id', requestId).eq('user_id', user.id).eq('branch', branch)
      .eq('status', 'preview_ready').maybeSingle();
    if (!matchesChangePreview(data, branch, form.get('deployment_sha'), origin))
      throw new Error('This preview does not match your change request.');
    row = data;
    if (row.target !== requestedTarget) throw new Error('This build belongs to a different change-request target.');
    const pr = await github(`${repoPath}/pulls/${data.pr_number}`);
    if (pr.state !== 'open' || pr.base?.ref !== 'staging' || !isChangeBranch(pr.head?.ref)
        || pr.head?.ref !== branch)
      throw new Error('The preview PR is no longer open on this branch.');
    await purgeChangeRequestScreenshots(db, bucket, row);
  } else {
    const { data, error } = await db.from('change_requests').insert({
      user_id: user.id, email: user.email, target: requestedTarget,
    }).select('*').single();
    if (error) throw error;
    row = data;
  }
  const { paths, links } = await storeImages(String(row.id), files);
  const target = String(row.target || requestedTarget);
  const prompt = [
    'Implement this BrickBuilder product change. Follow the repository instructions. Work only on the new task branch created from staging, then open or update its pull request targeting staging. Never commit directly to staging or main. Do not include private user data in code or pull request text.',
    target === 'ios'
      ? 'This request targets the Expo iOS app under mobile/. BrickBuilder mobile is a thin WebView shell: reuse the shared frontend and backend business logic, and add native code only for UI wrapping or platform integration. Keep the existing bundle identifier and EAS project. Ensure mobile type checking and tests pass.'
      : 'This request targets the BrickBuilder web app.',
    '', description.trim(), '',
    ...links.map((link, i) => `Screenshot ${i + 1} (expires in 4 hours): ${link}`),
  ].join('\n');
  let task;
  try {
    task = await github(`/agents${repoPath}/tasks`, 'POST', {
      prompt, base_ref: 'staging',
      ...(branch === 'main' ? {} : { head_ref: branch }),
      create_pull_request: true,
    });
  } catch (error) {
    await purgeChangeRequestScreenshots(db, bucket, { id: row.id, screenshots: paths });
    if (branch === 'main') await db.from('change_requests').update({ status: 'failed' }).eq('id', row.id);
    throw error;
  }
  const { error: updateError } = await db.from('change_requests').update({
    task_id: task.id, status: 'working', screenshots: paths,
    revision: Number(row.revision) + (branch === 'main' ? 0 : 1),
    preview_url: null, notified_sha: null, preview_email_sent_at: null, agent_completed_sha: null,
    mobile_build_sha: null, mobile_build_url: null, testflight_url: null,
    mobile_email_sent_at: null,
    deadline_at: new Date(Date.now() + 3 * 3600000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', row.id);
  if (updateError) {
    await purgeChangeRequestScreenshots(db, bucket, { id: row.id, screenshots: paths });
    throw updateError;
  }
  return { id: row.id, status: 'working', target };
}

async function getStatus(user: { id: string }, input: Record<string, unknown>) {
  let query = db.from('change_requests')
    .select('id,status,target,branch,pr_number,preview_url,testflight_url,mobile_build_url,notified_sha,revision,created_at')
    .eq('user_id', user.id);
  if (typeof input.request_id === 'string' && input.request_id) query = query.eq('id', input.request_id);
  else if (typeof input.branch === 'string' && input.branch !== 'main') query = query.eq('branch', input.branch);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return { request: data };
}

async function approve(user: { id: string }, input: Record<string, unknown>, origin: string) {
  const { data: row } = await db.from('change_requests').select('*')
    .eq('id', input.request_id).eq('user_id', user.id).eq('status', 'preview_ready').maybeSingle();
  if (!matchesChangePreview(row, input.branch, input.deployment_sha, origin))
    throw new Error('Open the matching preview before approving.');
  await purgeChangeRequestScreenshots(db, bucket, row);
  const pr = await github(`${repoPath}/pulls/${row.pr_number}`);
  if (pr.state !== 'open' || pr.base?.ref !== 'staging' || !isChangeBranch(pr.head?.ref)
      || pr.head?.ref !== row.branch
      || pr.head?.sha !== row.notified_sha)
    throw new Error('The PR changed since the preview email. Wait for a fresh preview.');
  const readyRequest = pullReadyRequest(pr);
  if (readyRequest) {
    const ready = await github('/graphql', 'POST', readyRequest);
    if (ready.errors?.length
        || ready.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
      throw new Error('GitHub could not mark this PR ready for review.');
    }
  }
  await mergePreviewPull(row.pr_number, pr.head.sha);
  await db.from('change_requests').update({ status: 'approved', updated_at: new Date().toISOString() }).eq('id', row.id);
  try { return await finishApproval(row); }
  catch (error) {
    console.error('change request approval follow-up failed:', error instanceof Error ? error.message : 'unknown');
    return { status: 'approved', email_pending: true };
  }
}

async function finishApproval(row: Record<string, any>) {
  let mainPr;
  if (row.main_pr_url) mainPr = { html_url: row.main_pr_url };
  else {
    const existing = await github(`${repoPath}/pulls?state=open&base=main&head=${repo.split('/')[0]}:staging`);
    if (existing.length) mainPr = existing[0];
    else mainPr = await github(`${repoPath}/pulls`, 'POST', {
      title: `Promote staging to main after change request ${row.id}`,
      head: 'staging', base: 'main',
      body: `Approved change request ${row.id}. Review the staging changes before merging to main.`,
    });
    await db.from('change_requests').update({ main_pr_url: mainPr.html_url }).eq('id', row.id);
  }
  await sendMail(row.email, 'BrickBuilder change ready for main review', [
    'Your approved change was merged into staging.',
    `Main pull request: ${mainPr.html_url}`,
    'Please review the pull request before merging to main.',
  ]);
  await db.from('change_requests').update({ approval_email_sent_at: new Date().toISOString() }).eq('id', row.id);
  return { status: 'approved', main_pr_url: mainPr.html_url };
}

async function requestForPull(pr: Record<string, any>) {
  const byBranch = await db.from('change_requests').select('*')
    .eq('branch', pr.head.ref).in('status', ['working', 'building', 'preview_ready']).maybeSingle();
  if (byBranch.error) throw byBranch.error;
  if (byBranch.data && (!byBranch.data.pr_number || byBranch.data.pr_number === pr.number)) return byBranch.data;

  const candidates = await db.from('change_requests').select('*')
    .eq('status', 'working').is('branch', null).order('created_at', { ascending: false }).limit(20);
  if (candidates.error) throw candidates.error;
  for (const candidate of candidates.data || []) {
    if (!candidate.task_id) continue;
    const task = await github(`/agents${repoPath}/tasks/${candidate.task_id}`);
    const pullId = taskPullNumber(task);
    if (pullId === pr.number || pullId === pr.id || taskBranchName(task) === pr.head.ref) {
      return candidate;
    }
  }

  return null;
}

async function acceptVercelPreview(event: Record<string, any>) {
  const preview = parseGitHubVercelPreview(event);
  if (!preview) return { accepted: true, ignored: true };

  const pulls = await github(`${repoPath}/commits/${preview.sha}/pulls`);
  const pr = pulls.find((item: Record<string, any>) => item.state === 'open'
    && item.base?.ref === 'staging' && item.head?.sha?.toLowerCase() === preview.sha
    && isChangeBranch(item.head?.ref));
  if (!pr) return { accepted: true, ignored: true };
  const row = await requestForPull(pr);
  if (!row) {
    if (pr.user?.login?.toLowerCase().includes('copilot')) throw new Error('Copilot request is not ready yet.');
    return { accepted: true, ignored: true };
  }
  if (row.target === 'ios') return { accepted: true, ignored: true };
  if (row.notified_sha === preview.sha && row.preview_email_sent_at) {
    return { accepted: true, duplicate: true };
  }

  const now = new Date().toISOString();
  const update = await db.from('change_requests').update({
    branch: pr.head.ref, pr_number: pr.number,
    preview_url: preview.url, notified_sha: preview.sha,
    preview_email_sent_at: null, updated_at: now,
  }).eq('id', row.id).select('agent_completed_sha').single();
  if (update.error) throw update.error;
  if (update.data.agent_completed_sha !== preview.sha) {
    return { accepted: true, waiting_for: 'agent' };
  }
  return deliverPreview(row, pr, preview.sha, preview.url, now);
}

async function deliverPreview(row: Record<string, any>, pr: Record<string, any>, sha: string,
  previewUrl: string, now = new Date().toISOString()) {
  const { data: linkData, error: linkError } = await db.auth.admin.generateLink({
    type: 'magiclink', email: row.email,
  });
  if (linkError) throw new Error(linkError.message);
  const signedPreviewUrl = previewAuthLink(previewUrl, row.id, linkData?.properties);
  const email = previewEmailMessage(signedPreviewUrl, pr);
  await sendMail(row.email, email.subject, email.lines);
  const sent = await db.from('change_requests').update({
    status: 'preview_ready', branch: pr.head.ref, pr_number: pr.number,
    preview_url: previewUrl, notified_sha: sha, preview_email_sent_at: now, updated_at: now,
  }).eq('id', row.id);
  if (sent.error) throw sent.error;
  return { accepted: true, request_id: row.id };
}

async function acceptAgentCompletion(eventName: string, event: Record<string, any>) {
  const completion = parseGitHubAgentCompletion(eventName, event);
  if (!completion) return { accepted: true, ignored: true };
  const pr = event.pull_request;
  const row = await requestForPull(pr);
  if (!row) return { accepted: true, ignored: true };
  await purgeChangeRequestScreenshots(db, bucket, row);
  if (row.target === 'ios') {
    if (row.notified_sha === completion.sha && row.mobile_email_sent_at) {
      return { accepted: true, duplicate: true, target: 'ios' };
    }
    if (row.mobile_build_sha === completion.sha && row.status === 'building'
        && event.retry !== true) {
      return { accepted: true, duplicate: true, target: 'ios' };
    }
    const now = new Date().toISOString();
    const saved = await db.from('change_requests').update({
      agent_completed_sha: completion.sha,
      mobile_build_sha: completion.sha,
      mobile_build_url: null,
      testflight_url: null,
      mobile_email_sent_at: null,
      branch: completion.branch,
      pr_number: completion.number,
      status: 'building',
      updated_at: now,
    }).eq('id', row.id);
    if (saved.error) throw saved.error;
    return {
      accepted: true,
      target: 'ios',
      build_required: true,
      request_id: row.id,
      branch: completion.branch,
      pr_number: completion.number,
      sha: completion.sha,
    };
  }
  if (row.notified_sha === completion.sha && row.preview_email_sent_at) {
    return { accepted: true, duplicate: true };
  }
  const now = new Date().toISOString();
  const saved = await db.from('change_requests').update({
    agent_completed_sha: completion.sha, branch: completion.branch, pr_number: completion.number,
    updated_at: now,
  }).eq('id', row.id).select('notified_sha,preview_url').single();
  if (saved.error) throw saved.error;
  if (saved.data.notified_sha !== completion.sha || !saved.data.preview_url) {
    return { accepted: true, waiting_for: 'vercel' };
  }
  return deliverPreview(row, pr, completion.sha, saved.data.preview_url, now);
}

async function acceptTestFlightReady(event: Record<string, any>) {
  const ready = parseTestFlightReady(event);
  if (!ready) return { accepted: true, ignored: true };
  const pr = await github(`${repoPath}/pulls/${ready.prNumber}`);
  if (pr.state !== 'open' || pr.base?.ref !== 'staging'
      || pr.head?.sha?.toLowerCase() !== ready.sha || !isChangeBranch(pr.head?.ref)) {
    return { accepted: true, ignored: true };
  }
  const row = await requestForPull(pr);
  if (!row || row.target !== 'ios' || row.agent_completed_sha !== ready.sha
      || row.mobile_build_sha !== ready.sha) return { accepted: true, ignored: true };
  if (row.notified_sha === ready.sha && row.mobile_email_sent_at) {
    return { accepted: true, duplicate: true };
  }
  const testFlightUrl = Deno.env.get('CHANGE_REQUEST_TESTFLIGHT_URL') || '';
  const email = testFlightEmailMessage(testFlightUrl, ready.buildUrl, pr);
  await sendMail(row.email, email.subject, email.lines);
  const now = new Date().toISOString();
  const saved = await db.from('change_requests').update({
    status: 'preview_ready',
    branch: pr.head.ref,
    pr_number: pr.number,
    notified_sha: ready.sha,
    mobile_build_url: ready.buildUrl,
    testflight_url: testFlightUrl,
    mobile_email_sent_at: now,
    updated_at: now,
  }).eq('id', row.id);
  if (saved.error) throw saved.error;
  return { accepted: true, request_id: row.id };
}

Deno.serve(async (request) => {
  const origin = allowedOrigin(request);
  if (origin === null) return response({ error: 'Origin not allowed.' }, 403);
  if (request.method === 'OPTIONS') return response({}, 200, origin);
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405, origin);
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.startsWith('multipart/form-data')) {
      const user = await account(request);
      return response(await submit(request, user, origin), 200, origin);
    }
    const rawBody = await request.text();
    const input = JSON.parse(rawBody);
    if (['vercel_preview', 'agent_complete', 'testflight_ready'].includes(input?.action)) {
      const secret = Deno.env.get('CHANGE_REQUEST_GITHUB_EVENT_SECRET') || '';
      if (!secret || request.headers.get('x-change-request-event-secret') !== secret) {
        return response({ error: 'Invalid GitHub event secret.' }, 401);
      }
      try {
        if (input.action === 'vercel_preview') return response(await acceptVercelPreview(input));
        if (input.action === 'testflight_ready') return response(await acceptTestFlightReady(input));
        if (!Number.isInteger(input.pr_number) || !/^[0-9a-f]{40}$/i.test(input.sha || '')) {
          return response({ accepted: true, ignored: true });
        }
        const pr = await github(`${repoPath}/pulls/${input.pr_number}`);
        if (pr.head?.sha?.toLowerCase() !== input.sha.toLowerCase()) {
          return response({ accepted: true, ignored: true });
        }
        return response(await acceptAgentCompletion('pull_request', {
          action: 'review_requested', pull_request: pr, retry: input.retry === true,
        }));
      } catch (error) {
        console.error('GitHub event failed:', error instanceof Error ? error.message : 'unknown');
        return response({ error: 'Event processing failed.' }, 502);
      }
    }
    const user = await account(request);
    if (input.action === 'access') return response({ enabled: true }, 200, origin);
    if (input.action === 'status') return response(await getStatus(user, input), 200, origin);
    if (input.action === 'approve') return response(await approve(user, input, origin), 200, origin);
    return response({ error: 'Unknown action.' }, 400, origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed.';
    const status = /access|Sign in|Unauthorized/.test(message) ? 403 : 400;
    return response({ error: message }, status, origin);
  }
});
