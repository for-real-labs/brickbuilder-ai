import { apiFetch } from './apiFetch';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { getNativeMobileShellInfo } from '../utils/mobileShellAnalytics';

const mode = import.meta.env.VITE_API_MODE || 'local';
const backend = mode === 'local' ? import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002'
  : mode === 'railway_staging' ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
  : import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';

export const APPLE_SIGN_IN_EVENT = 'brickbuilder:apple-sign-in';

export function deviceAuthOptions() {
  const shell = getNativeMobileShellInfo();
  return {
    apple: import.meta.env.VITE_APPLE_SIGN_IN_ENABLED === 'true' && isSupabaseConfigured
      && shell?.platform === 'ios' && shell.appleSignIn === true && Boolean(window.ReactNativeWebView),
    passkey: import.meta.env.VITE_PASSKEYS_ENABLED === 'true' && isSupabaseConfigured
      && typeof window !== 'undefined' && window.isSecureContext
      && typeof window.PublicKeyCredential === 'function' && (!shell || shell.passkeys === true),
  };
}

function requestAppleCredential(nonce: string, signal: AbortSignal): Promise<{ token: string; code: string } | null> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const bridge = window.ReactNativeWebView;
    if (!bridge || signal.aborted) { resolve(null); return; }
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      window.removeEventListener(APPLE_SIGN_IN_EVENT, respond);
    };
    const abort = () => { finish(); resolve(null); };
    const respond = (event: Event) => {
      const result = (event as CustomEvent).detail;
      if (result?.id !== id) return;
      finish();
      if (result.cancelled === true) resolve(null);
      else if (typeof result.token === 'string' && result.token && typeof result.code === 'string' && result.code) {
        resolve({ token: result.token, code: result.code });
      }
      else reject(new Error('Apple sign-in could not finish. Please try again.'));
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error('Apple sign-in timed out. Please try again.'));
    }, 120_000);
    window.addEventListener(APPLE_SIGN_IN_EVENT, respond);
    signal.addEventListener('abort', abort, { once: true });
    try {
      bridge.postMessage(JSON.stringify({ type: APPLE_SIGN_IN_EVENT, id, nonce }));
    } catch (error) {
      finish();
      reject(error);
    }
  });
}

export async function signInWithApple(signal: AbortSignal): Promise<boolean> {
  const nonce = crypto.randomUUID();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce));
  const hashed = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const credential = await requestAppleCredential(hashed, signal);
  if (!credential || signal.aborted) return false;
  const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.token, nonce });
  if (error || !data.session) throw new Error('Apple sign-in could not finish. You can also sign in with email.');
  try {
    const response = await apiFetch(`${backend}/account/apple-authorization`, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ authorization_code: credential.code }),
    });
    if (!response.ok) throw new Error('Could not save Apple authorization');
  } catch {
    const { data: current } = await supabase.auth.getSession();
    if (current.session?.access_token === data.session.access_token) await supabase.auth.signOut({ scope: 'local' });
    throw new Error('Apple sign-in could not finish. Please try again or use email.');
  }
  return true;
}

export async function signInWithPasskey(signal: AbortSignal): Promise<boolean> {
  const { data, error } = await supabase.auth.signInWithPasskey({ options: { signal } });
  if (signal.aborted) return false;
  if (error || !data.session) throw new Error('Passkey sign-in could not finish. Use email if you haven’t added a passkey yet.');
  return true;
}
