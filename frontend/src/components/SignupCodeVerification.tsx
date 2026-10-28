import React, { useState } from 'react';
import posthog from 'posthog-js';
import { resendSignupCode, verifySignupCode } from '../services/passwordAuth';

export function SignupCodeVerification({ email, redirectPath, surface, onVerified, onBack }: {
  email: string; redirectPath?: string; surface: string; onVerified: () => void; onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  const verify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!/^\d{6,10}$/.test(code.trim())) { setError('Enter the verification code from your email.'); return; }
    setBusy(true);
    posthog.capture('auth_signup_code_submitted', { surface });
    try {
      await verifySignupCode(email, code);
      posthog.capture('auth_signup_code_verified', { surface });
      onVerified();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Verification failed. Please try again.'); }
    finally { setBusy(false); }
  };
  const resend = async () => {
    if (busy) return;
    setBusy(true); setError(''); setResent(false);
    posthog.capture('auth_signup_code_resent', { surface });
    try { await resendSignupCode(email, redirectPath); setResent(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not resend the code.'); }
    finally { setBusy(false); }
  };
  return <section className="mt-5">
    <p role="status" className="text-sm text-slate-600">Please check your email for a verification code. Enter it here to finish signing in—no second password entry.</p>
    <form onSubmit={verify} className="mt-4 space-y-4">
      <label className="block text-sm font-medium text-slate-700">Verification code
        <input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus required maxLength={10}
          value={code} onChange={event => setCode(event.target.value)} disabled={busy}
          className="mt-1 h-12 w-full rounded-lg border border-slate-300 px-3 text-center text-lg tracking-widest" />
      </label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-11 w-full rounded-xl bg-[#e94439] px-4 text-white font-semibold disabled:opacity-50">{busy ? 'Please wait…' : 'Verify and sign in'}</button>
    </form>
    <div className="mt-3 flex justify-between gap-3 text-sm">
      <button type="button" disabled={busy} className="min-h-11 text-slate-600 underline" onClick={() => { posthog.capture('auth_signup_code_back', { surface }); onBack(); }}>Change email</button>
      <button type="button" disabled={busy} className="min-h-11 text-[#c83228] underline" onClick={() => void resend()}>Resend code</button>
    </div>
    {resent && <p role="status" className="mt-2 text-sm text-green-800">A new code was requested. Check your email.</p>}
    <p className="mt-3 text-xs text-slate-500">Already registered and no code arrived? Your password may be incorrect. Use the password reset option below.</p>
  </section>;
}
