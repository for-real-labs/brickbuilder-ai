import { referralSignupMetadata } from './referrals';
import { supabase, passwordRecoveryClient } from '../lib/supabase';
import { getNativeMobileShellInfo } from '../utils/mobileShellAnalytics';
import { loginRedirect } from '../utils/loginRedirect';

// Per-request marker selects the code-only template; it is not an auth permission.
export function confirmationRedirect(redirectPath?: string) {
  if (getNativeMobileShellInfo()?.platform === 'ios') return 'https://brickbuilder.ai/login?verification=ios-code';
  return `${window.location.origin}${loginRedirect('', redirectPath)}`;
}

export async function resendSignupCode(email: string, redirectPath?: string) {
  const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(),
    options: { emailRedirectTo: confirmationRedirect(redirectPath) } });
  if (error) throw error;
}

export async function verifySignupCode(email: string, token: string) {
  const { data, error } = await supabase.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: 'email' });
  if (error) throw error;
  if (!data.session) throw new Error('Verification did not complete. Please request a new code.');
}

export async function signInOrCreateAccount(email: string, password: string, redirectPath?: string) {
  const credentials = { email: email.trim(), password };
  const signedIn = await supabase.auth.signInWithPassword(credentials);
  if (!signedIn.error) return { error: null, confirmationRequired: false };
  if (signedIn.error.code === 'email_not_confirmed') {
    try { await resendSignupCode(email, redirectPath); return { error: null, confirmationRequired: true }; }
    catch (error) { return { error: error as typeof signedIn.error, confirmationRequired: false }; }
  }
  // Supabase deliberately does not distinguish an unknown email from a wrong
  // password. Signup cannot overwrite an existing confirmed account's password.
  if (signedIn.error.code !== 'invalid_credentials') {
    return { error: signedIn.error, confirmationRequired: false };
  }
  const signedUp = await supabase.auth.signUp({
    ...credentials,
    options: { data: { password_configured: true, ...await referralSignupMetadata() }, emailRedirectTo: confirmationRedirect(redirectPath) },
  });
  return { error: signedUp.error, confirmationRequired: !signedUp.error && !signedUp.data.session };
}

export async function sendPasswordRecovery(email: string) {
  const { error } = await passwordRecoveryClient().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${window.location.origin}/reset-password`,
  });
  if (error) throw error;
}

export async function hasAccountPassword(): Promise<boolean> {
  const { data, error } = await supabase.rpc('account_has_password');
  if (error) throw error;
  if (typeof data !== 'boolean') throw new Error('Could not load password settings.');
  return data;
}

export async function saveAccountPassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

// Finish consuming a recovery link before analytics mounts. Access/refresh
// tokens in its URL fragment must never be captured in pageview URLs.
export async function preparePasswordRecoveryPage() {
  if (window.location.pathname !== '/reset-password') return;
  try { await supabase.auth.getSession(); }
  catch { /* The recovery page offers a fresh link when no session is available. */ }
  finally {
    const url = new URL(window.location.href);
    url.hash = '';
    for (const key of ['code', 'error', 'error_code', 'error_description']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.pathname + url.search);
  }
}
