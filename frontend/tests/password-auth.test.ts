import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ signIn: vi.fn(), signUp: vi.fn(), reset: vi.fn(), update: vi.fn(), rpc: vi.fn(), session: vi.fn(), resend: vi.fn(), verify: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: mocks.signIn, signUp: mocks.signUp, updateUser: mocks.update, getSession: mocks.session, resend: mocks.resend, verifyOtp: mocks.verify }, rpc: mocks.rpc },
  passwordRecoveryClient: () => ({ auth: { resetPasswordForEmail: mocks.reset } }),
}));
import { signInOrCreateAccount, sendPasswordRecovery, hasAccountPassword, saveAccountPassword, preparePasswordRecoveryPage, resendSignupCode, verifySignupCode } from '../src/services/passwordAuth';
beforeEach(() => { vi.resetAllMocks(); delete window.__BRICKBUILDER_NATIVE_APP__; });
it('signs in existing accounts without trying signup', async () => {
  mocks.signIn.mockResolvedValue({ error: null });
  expect(await signInOrCreateAccount(' person@example.test ', 'existing')).toEqual({ error: null, confirmationRequired: false });
  expect(mocks.signIn).toHaveBeenCalledWith({ email: 'person@example.test', password: 'existing' });
  expect(mocks.signUp).not.toHaveBeenCalled();
});
it('creates a new account after invalid credentials and waits for confirmation', async () => {
  mocks.signIn.mockResolvedValue({ error: { code: 'invalid_credentials' } });
  mocks.signUp.mockResolvedValue({ error: null, data: { session: null } });
  expect(await signInOrCreateAccount('new@example.test', 'new-password', '/community')).toEqual({ error: null, confirmationRequired: true });
  expect(mocks.signUp).toHaveBeenCalledWith({ email: 'new@example.test', password: 'new-password', options: { data: { password_configured: true }, emailRedirectTo: `${location.origin}/community` } });
  expect(mocks.update).not.toHaveBeenCalled();
});
it('never overwrites the password when an existing account is returned as an obfuscated signup', async () => {
  mocks.signIn.mockResolvedValue({ error: { code: 'invalid_credentials' } });
  mocks.signUp.mockResolvedValue({ error: null, data: { session: null, user: { identities: [] } } });
  expect((await signInOrCreateAccount('existing@example.test', 'wrong-password')).confirmationRequired).toBe(true);
  expect(mocks.update).not.toHaveBeenCalled();
});
it.each(['over_request_rate_limit', 'request_timeout'])('does not signup on %s', async code => {
  const error = { code }; mocks.signIn.mockResolvedValue({ error });
  expect((await signInOrCreateAccount('person@example.test', 'password')).error).toBe(error);
  expect(mocks.signUp).not.toHaveBeenCalled();
});
it('allows signup sessions when confirmation is disabled, and rejects external redirects', async () => {
  mocks.signIn.mockResolvedValue({ error: { code: 'invalid_credentials' } });
  mocks.signUp.mockResolvedValue({ error: null, data: { session: { user: {} } } });
  expect((await signInOrCreateAccount('new@example.test', 'password', '//evil.test')).confirmationRequired).toBe(false);
  expect(mocks.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(`${location.origin}/dashboard`);
});
it('returns signup errors without claiming that email was sent', async () => {
  mocks.signIn.mockResolvedValue({ error: { code: 'invalid_credentials' } });
  const error = new Error('Password is too weak'); mocks.signUp.mockResolvedValue({ error, data: { session: null } });
  expect(await signInOrCreateAccount('new@example.test', 'weak')).toEqual({ error, confirmationRequired: false });
});
it('sends a reset link to the dedicated same-origin recovery page', async () => {
  mocks.reset.mockResolvedValue({ error: null });
  await sendPasswordRecovery(' person@example.test ');
  expect(mocks.reset).toHaveBeenCalledWith('person@example.test', { redirectTo: `${location.origin}/reset-password` });
  mocks.reset.mockResolvedValue({ error: new Error('Try later') });
  await expect(sendPasswordRecovery('person@example.test')).rejects.toThrow('Try later');
});
it('reads only the current account password status, never a user-supplied id', async () => {
  mocks.rpc.mockResolvedValue({ data: false, error: null }); expect(await hasAccountPassword()).toBe(false);
  expect(mocks.rpc).toHaveBeenCalledWith('account_has_password');
  mocks.rpc.mockResolvedValue({ data: null, error: new Error('Denied') }); await expect(hasAccountPassword()).rejects.toThrow('Denied');
  mocks.rpc.mockResolvedValue({ data: null, error: null }); await expect(hasAccountPassword()).rejects.toThrow('Could not load');
});
it('sets the password using the signed-in Supabase session and propagates errors', async () => {
  mocks.update.mockResolvedValue({ error: null }); await saveAccountPassword('strong-password');
  expect(mocks.update).toHaveBeenCalledWith({ password: 'strong-password' });
  mocks.update.mockResolvedValue({ error: new Error('Expired') }); await expect(saveAccountPassword('password')).rejects.toThrow('Expired');
});

it('consumes recovery tokens before removing callback data from analytics-visible URLs', async () => {
  window.history.replaceState(null, '', '/reset-password#access_token=secret&refresh_token=secret&type=recovery');
  mocks.session.mockImplementation(async () => {
    expect(location.hash).toContain('access_token');
    return { data: { session: {} }, error: null };
  });
  await preparePasswordRecoveryPage();
  expect(location.hash).toBe(''); expect(location.pathname).toBe('/reset-password');
  window.history.replaceState(null, '', '/');
});
it('cleans failed callbacks too and leaves normal login URLs alone', async () => {
  window.history.replaceState(null, '', '/reset-password?error_code=expired#access_token=secret');
  mocks.session.mockRejectedValue(new Error('Expired'));
  await preparePasswordRecoveryPage(); expect(location.href).not.toContain('secret'); expect(location.search).toBe('');
  mocks.session.mockClear(); window.history.replaceState(null, '', '/login?next=%2Fcommunity');
  await preparePasswordRecoveryPage(); expect(mocks.session).not.toHaveBeenCalled(); expect(location.search).toContain('next');
  window.history.replaceState(null, '', '/');
});

it('uses code-only delivery for native iOS signup and resend, but not Safari', async () => {
  mocks.signIn.mockResolvedValue({ error: { code: 'invalid_credentials' } });
  mocks.signUp.mockResolvedValue({ error: null, data: { session: null } });
  mocks.resend.mockResolvedValue({ error: null });
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '1.0.5' };
  await signInOrCreateAccount('ios@example.test', 'password');
  expect(mocks.signUp.mock.calls[0][0].options.emailRedirectTo).toBe('https://brickbuilder.ai/login?verification=ios-code');
  await resendSignupCode('ios@example.test');
  expect(mocks.resend.mock.calls[0][0].options.emailRedirectTo).toBe('https://brickbuilder.ai/login?verification=ios-code');
  delete window.__BRICKBUILDER_NATIVE_APP__;
  await signInOrCreateAccount('web@example.test', 'password');
  expect(mocks.signUp.mock.calls[1][0].options.emailRedirectTo).toBe(`${location.origin}/dashboard`);
});
it('resends confirmation for an unconfirmed account without changing its password', async () => {
  mocks.signIn.mockResolvedValue({ error: { code: 'email_not_confirmed' } });
  mocks.resend.mockResolvedValue({ error: null });
  expect(await signInOrCreateAccount('pending@example.test','password')).toEqual({ error: null, confirmationRequired: true });
  expect(mocks.signUp).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
});
it('verifies a signup code and requires the returned authenticated session', async () => {
  mocks.verify.mockResolvedValueOnce({ error: null, data: { session: { access_token: 'test' } } });
  await verifySignupCode(' person@example.test ', ' 123456 ');
  expect(mocks.verify).toHaveBeenCalledWith({ email: 'person@example.test', token: '123456', type: 'email' });
  mocks.verify.mockResolvedValueOnce({ error: null, data: { session: null } });
  await expect(verifySignupCode('person@example.test','123456')).rejects.toThrow('Verification did not complete');
  expect(mocks.signIn).not.toHaveBeenCalled();
});
