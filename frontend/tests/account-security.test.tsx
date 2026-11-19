import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MfaSettings } from '../src/components/MfaSettings';
import { PasskeyPrompt } from '../src/components/PasskeyPrompt';
import { AuthProvider, useAuth } from '../src/contexts/AuthContext';

const mocked = vi.hoisted(() => ({
  register: vi.fn(), passkeys: vi.fn(), factors: vi.fn(), assurance: vi.fn(),
  enroll: vi.fn(), verify: vi.fn(), unenroll: vi.fn(), session: vi.fn(),
  profile: vi.fn(), callback: null as ((event: string, session: unknown) => void) | null,
}));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/deviceAuth', () => ({
  deviceAuthOptions: () => ({ passkey: true }),
  addAccountPasskey: mocked.register,
}));
vi.mock('../src/lib/supabase', () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: {
      getSession: mocked.session,
      onAuthStateChange: (callback: typeof mocked.callback) => {
        mocked.callback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      passkey: { list: mocked.passkeys },
      mfa: {
        listFactors: mocked.factors, getAuthenticatorAssuranceLevel: mocked.assurance,
        enroll: mocked.enroll, challengeAndVerify: mocked.verify, unenroll: mocked.unenroll,
      },
    },
    from: () => ({ select: () => ({ eq: () => ({ single: mocked.profile }) }) }),
  },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const user = { id: 'test-account', email: 'builder@example.test' };
const session = (access_token: string) => ({ access_token, user });
const success = <T,>(data: T) => ({ data, error: null });
const button = (label: string) => Array.from(container.querySelectorAll('button'))
  .find(item => item.textContent === label)!;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('VITE_MFA_ENABLED', 'true');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  mocked.passkeys.mockResolvedValue(success([]));
  mocked.factors.mockResolvedValue(success({ totp: [] }));
  mocked.assurance.mockResolvedValue(success({ currentLevel: 'aal1', nextLevel: 'aal1' }));
  mocked.profile.mockResolvedValue(success({}));
  mocked.session.mockResolvedValue(success({ session: session('first-factor') }));
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
  Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('offers a passkey and registers it only when requested', async () => {
  mocked.register.mockResolvedValue(undefined);
  await act(async () => root.render(<PasskeyPrompt userId={user.id} />));
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(mocked.register).not.toHaveBeenCalled();
  await act(async () => button('Add a passkey').click());
  expect(mocked.register).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(container.querySelector('dialog')).toBeNull();
});

it('remembers Not now for an account and skips accounts that already have a passkey', async () => {
  await act(async () => root.render(<PasskeyPrompt key="first" userId={user.id} />));
  act(() => button('Not now').click());
  await act(async () => root.render(<PasskeyPrompt key="returning" userId={user.id} />));
  expect(container.querySelector('dialog')).toBeNull();
  expect(mocked.passkeys).toHaveBeenCalledOnce();

  mocked.passkeys.mockResolvedValue(success([{ id: 'existing-passkey' }]));
  await act(async () => root.render(<PasskeyPrompt key="existing" userId="other-user" />));
  expect(container.querySelector('dialog')).toBeNull();
  expect(mocked.passkeys).toHaveBeenCalledTimes(2);
});

it('withholds the signed-in session and account reads until MFA is verified', async () => {
  mocked.assurance.mockImplementation(async token => success({
    currentLevel: token === 'verified' ? 'aal2' : 'aal1', nextLevel: 'aal2',
  }));
  mocked.factors.mockResolvedValue(success({ totp: [{ id: 'authenticator' }] }));
  mocked.passkeys.mockResolvedValue(success([{ id: 'existing-passkey' }]));
  function Account() { return useAuth().session ? <p>Signed in</p> : null; }
  await act(async () => root.render(<AuthProvider><Account /></AuthProvider>));
  expect(container.textContent).toContain('Verify your sign-in');
  expect(container.textContent).not.toContain('Signed in');
  expect(mocked.profile).not.toHaveBeenCalled();
  expect(mocked.passkeys).not.toHaveBeenCalled();

  await act(async () => mocked.callback!('MFA_CHALLENGE_VERIFIED', session('verified')));
  expect(container.textContent).toContain('Signed in');
  expect(container.textContent).not.toContain('Verify your sign-in');
  expect(mocked.profile).toHaveBeenCalledOnce();
});

it('verifies authenticator setup and confirms before turning off MFA', async () => {
  mocked.passkeys.mockResolvedValue(success([{ id: 'existing-passkey' }]));
  mocked.enroll.mockResolvedValue(success({ id: 'authenticator', totp: { qr_code: 'data:,qr', secret: 'test-key' } }));
  mocked.verify.mockImplementation(async () => {
    mocked.factors.mockResolvedValue(success({ totp: [{ id: 'authenticator' }] }));
    return success({});
  });
  mocked.unenroll.mockImplementation(async () => {
    mocked.factors.mockResolvedValue(success({ totp: [] }));
    return success(null);
  });
  await act(async () => root.render(<AuthProvider><MfaSettings /></AuthProvider>));
  await act(async () => button('Turn on MFA').click());
  expect(mocked.enroll).toHaveBeenCalledWith({ factorType: 'totp', issuer: 'BrickBuilder' });
  expect(container.textContent).toContain('test-key');
  expect(button('Verify code').disabled).toBe(true);

  const input = container.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Verify code').click());
  expect(mocked.verify).toHaveBeenCalledWith({ factorId: 'authenticator', code: '123456' });
  expect(container.textContent).toContain('Add another authenticator');

  act(() => button('Remove Authenticator 1').click());
  expect(mocked.unenroll).not.toHaveBeenCalled();
  await act(async () => button('Turn off MFA').click());
  expect(mocked.unenroll).toHaveBeenCalledWith({ factorId: 'authenticator' });
  expect(button('Turn on MFA')).toBeDefined();
});
