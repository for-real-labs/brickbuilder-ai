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
  const response = await fetch(url, { ...withGenerationEntryPage(url, init), headers: Object.fromEntries(headers.entries()) });
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
