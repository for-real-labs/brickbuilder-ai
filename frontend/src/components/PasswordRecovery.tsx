import React, { useState } from 'react';
import posthog from 'posthog-js';
import { sendPasswordRecovery } from '../services/passwordAuth';

export function PasswordRecovery({ email, surface }: { email: string; surface: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const send = async () => {
    if (busy) return;
    setError(''); setMessage('');
    if (!email.trim() || !email.includes('@')) { setError('Enter your email address first.'); return; }
    setBusy(true);
    posthog.capture('auth_password_recovery_requested', { surface });
    try {
      await sendPasswordRecovery(email);
      setMessage('If an account exists for this email, we sent a secure link to choose a new password. Check your inbox and spam folder.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the reset link. Please try again.');
    } finally { setBusy(false); }
  };
  return <div className="space-y-2">
    <button type="button" disabled={busy} className="min-h-11 w-full text-sm text-[#c83228] underline disabled:opacity-50" onClick={() => void send()}>
      {busy ? 'Sending reset link…' : 'Can’t log in? Email me a password reset link'}
    </button>
    {message && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </div>;
}
