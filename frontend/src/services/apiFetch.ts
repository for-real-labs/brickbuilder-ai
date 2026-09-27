import { getGuestSession } from '../utils/guestSession';

// Only backend API services use this transport; third-party requests use fetch.
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Guest-Session', getGuestSession());
  return fetch(url, { ...init, headers: Object.fromEntries(headers.entries()) });
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
