import { ensureAiConsent, requiresAiConsent } from '../utils/aiConsent';
import { withGenerationEntryPage } from '../utils/generationAttribution';
import { localizeGenerationLimit } from './generationLimit';
import { getGuestSession } from '../utils/guestSession';

// Only backend API services use this transport; third-party requests use fetch.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (requiresAiConsent(url, init.method)) {
    init.signal?.throwIfAborted();
    await ensureAiConsent();
    init.signal?.throwIfAborted();
  }
  const headers = new Headers(init.headers);
  headers.set('X-Guest-Session', getGuestSession());
  if (headers.has('Authorization') && init.method?.toUpperCase() === 'POST' && /\/(novaToBricks|llmToBricks)(?:Stream)?(?:[/?]|$)/.test(url) && typeof init.body === 'string') {
    const { prepareAiBilling } = await import('./providerKeysApi');
    init = { ...init, body: await prepareAiBilling(init.body, init.signal ?? undefined) };
    if (JSON.parse(init.body as string).billing_source === 'personal') {
      const { supabase } = await import('../lib/supabase');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session || headers.get('Authorization') !== `Bearer ${session.access_token}`) throw new Error('Your sign-in changed. Please submit your generation again.');
    }
  }
  const response = await fetch(url, { ...withGenerationEntryPage(url, init), headers: Object.fromEntries(headers.entries()) });
  if (init.method?.toUpperCase() === 'POST' && /\/(novaToBricks|llmToBricks|textToBricks|imageToBricks|promptEditModel|glbToBricks|objToBricks)(?:Stream)?(?:[/?]|$)/.test(url)) {
    if (response.status === 402) window.dispatchEvent(new Event('brickbuilder:credits-required'));
    if (response.ok) window.dispatchEvent(new Event('brickbuilder:credits-changed'));
  }
  return localizeGenerationLimit(response);
}

// Polling and SSE previously sent no credentials. Resolve the current session
// on every reconnect so logout or account changes cannot reuse an old token.
export async function authenticatedApiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const { supabase } = await import('../lib/supabase');
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (session?.access_token) headers.set('Authorization', `Bearer ${session.access_token}`);
  return apiFetch(url, { ...init, cache: 'no-store', headers });
}
