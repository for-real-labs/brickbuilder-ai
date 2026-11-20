import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APPLE_SIGN_IN_EVENT, deviceAuthOptions, signInWithApple, signInWithPasskey } from '../src/services/deviceAuth';

const auth = vi.hoisted(() => ({ signInWithIdToken: vi.fn(), signInWithPasskey: vi.fn(), getSession: vi.fn(), signOut: vi.fn() }));
const fetchApi = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/supabase', () => ({ isSupabaseConfigured: true, supabase: { auth } }));
vi.mock('../src/services/apiFetch', () => ({ apiFetch: fetchApi }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PublicKeyCredential', class {});
  vi.stubEnv('VITE_APPLE_SIGN_IN_ENABLED', 'true');
  vi.stubEnv('VITE_PASSKEYS_ENABLED', 'true');
});
afterEach(() => { delete window.__BRICKBUILDER_NATIVE_APP__; delete window.ReactNativeWebView; vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('requires a capable new iOS app for Apple and WebAuthn for browser passkeys', () => {
  expect(deviceAuthOptions()).toEqual({ apple: false, passkey: true });
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '0.2.0' };
  expect(deviceAuthOptions()).toEqual({ apple: false, passkey: false });
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '0.2.0', appleSignIn: true, passkeys: true };
  window.ReactNativeWebView = { postMessage: vi.fn() };
  expect(deviceAuthOptions()).toEqual({ apple: true, passkey: true });
});

it('binds the Apple ID token to a nonce and saves the code under the resulting session', async () => {
  let challenge = '';
  window.ReactNativeWebView = { postMessage: raw => {
    const request = JSON.parse(raw);
    challenge = request.nonce;
    window.dispatchEvent(new CustomEvent(APPLE_SIGN_IN_EVENT, { detail: { id: 'wrong', token: 'wrong', code: 'wrong' } }));
    window.dispatchEvent(new CustomEvent(APPLE_SIGN_IN_EVENT, { detail: { id: request.id, token: 'token', code: 'code' } }));
  } };
  auth.signInWithIdToken.mockResolvedValue({ data: { session: { access_token: 'session' } }, error: null });
  fetchApi.mockResolvedValue({ ok: true });
  expect(await signInWithApple(new AbortController().signal)).toBe(true);
  const payload = auth.signInWithIdToken.mock.calls[0][0];
  expect(payload).toMatchObject({ provider: 'apple', token: 'token' });
  const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(payload.nonce));
  expect(challenge).toBe(Buffer.from(digest).toString('hex'));
  expect(fetchApi).toHaveBeenCalledWith(expect.stringMatching(/\/account\/apple-authorization$/), expect.objectContaining({
    headers: expect.objectContaining({ Authorization: 'Bearer session' }),
    body: JSON.stringify({ authorization_code: 'code' }),
  }));
});

it('uses the Supabase passkey ceremony and returns only when a session exists', async () => {
  const signal = new AbortController().signal;
  auth.signInWithPasskey.mockResolvedValueOnce({ data: { session: null }, error: null })
    .mockResolvedValueOnce({ data: { session: {} }, error: null });
  await expect(signInWithPasskey(signal)).rejects.toThrow('Passkey sign-in could not finish');
  await expect(signInWithPasskey(signal)).resolves.toBe(true);
  expect(auth.signInWithPasskey).toHaveBeenCalledWith({ options: { signal } });
});
