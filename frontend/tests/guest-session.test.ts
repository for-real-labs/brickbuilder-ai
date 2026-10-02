import { saveAiConsent } from '../src/utils/aiConsent';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { getGuestSession } from '../src/utils/guestSession';
import { apiFetch, authenticatedApiFetch } from '../src/services/apiFetch';
import { getAnonymousGenerationIds } from '../src/utils/anonGenerations';

// Transport assertions exercise the already-consented state.
beforeEach(() => saveAiConsent(true));

afterEach(() => vi.unstubAllGlobals());

it('keeps a high-entropy session across reloads and separates fresh browsers', async () => {
  const first = getGuestSession();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  vi.resetModules();
  const reloaded = await import('../src/utils/guestSession');
  expect(reloaded.getGuestSession()).toBe(first);
  localStorage.clear();
  expect(reloaded.getGuestSession()).not.toBe(first);
});

it('replaces malformed stored credentials and ignores old claim IDs', () => {
  localStorage.setItem('brickbuilder_guest_session_v1', 'Mozilla/5.0');
  expect(getGuestSession()).toMatch(/^[0-9a-f]{64}$/);
  localStorage.setItem('anon_generation_ids', JSON.stringify(['another-users-job']));
  expect(getAnonymousGenerationIds()).toEqual([]);
});

it('keeps one in-memory guest credential when browser storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(getGuestSession()).toBe(getGuestSession());
});

it('sends guest proof on creation and claiming, preserving auth, body, and abort', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  await apiFetch('/llmToBricks', { method: 'POST', body: '{}', signal });
  await apiFetch('/claimGeneration', { headers: { Authorization: 'Bearer token' }, signal });
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}', signal, headers: { 'x-guest-session': getGuestSession() } });
  expect(fetch.mock.calls[1][1].headers).toMatchObject({ authorization: 'Bearer token', 'x-guest-session': getGuestSession() });
});

it('polling and SSE use the current account and stop sending it after logout', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetch);
  // Dynamic module import shares this module unless another test reset it.
  const current = await import('../src/lib/supabase');
  const getSession = vi.spyOn(current.supabase.auth, 'getSession');
  getSession.mockResolvedValue({ data: { session: { access_token: 'account-token' } }, error: null } as never);
  await authenticatedApiFetch('/generation/job');
  expect(fetch.mock.calls[0][1].headers.authorization).toBe('Bearer account-token');
  getSession.mockResolvedValue({ data: { session: null }, error: null });
  await authenticatedApiFetch('/generation/job/output');
  expect(fetch.mock.calls[1][1].headers.authorization).toBeUndefined();
});
