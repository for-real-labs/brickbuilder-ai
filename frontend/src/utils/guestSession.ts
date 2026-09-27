// This secret is a guest credential. Never put it in URLs, analytics, or logs.
const KEY = 'brickbuilder_guest_session_v1';
let fallback: string | undefined;

export function getGuestSession(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[0-9a-f]{64}$/.test(saved)) return saved;
  } catch { /* Use a page-scoped session when storage is unavailable. */ }
  const secret = fallback ?? Array.from(crypto.getRandomValues(new Uint8Array(32)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    localStorage.setItem(KEY, secret);
    fallback = undefined;
  } catch { fallback = secret; }
  return secret;
}
