import React, { useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { hasAccountPassword, sendPasswordRecovery } from '../services/passwordAuth';
import { PasswordEditor } from './PasswordEditor';

export function PasswordSettings() {
  const { user } = useAuth();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setHasPassword(null); setError(''); setEditing(false); setMessage('');
    if (user) void hasAccountPassword().then(value => { if (active) setHasPassword(value); })
      .catch(() => { if (active) setError('Could not load password settings.'); });
    return () => { active = false; };
  }, [user?.id, attempt]);
  if (!user?.email) return null;
  const reset = async () => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    posthog.capture('auth_password_recovery_requested', { surface: 'settings' });
    try {
      await sendPasswordRecovery(user.email!);
      setMessage('Check your email for a secure link to choose a new password.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send the reset link.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Password settings" className="my-6 max-w-2xl rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
    <h2 className="text-lg font-semibold">Password</h2>
    <p className="mt-2 text-sm text-slate-600">{hasPassword === null ? 'Checking password settings…' : hasPassword ? 'Reset your password with a secure link sent to your email.' : 'Add a password so you can also sign in with your email and password.'}</p>
    {hasPassword !== null && !editing && <button type="button" disabled={busy} className="mt-4 min-h-11 rounded-lg border border-slate-300 px-4 disabled:opacity-50" onClick={() => {
      if (hasPassword) void reset();
      else { posthog.capture('auth_set_password_opened', { surface: 'settings' }); setEditing(true); }
    }}>{busy ? 'Sending…' : hasPassword ? 'Reset password' : 'Set password'}</button>}
    {editing && <><PasswordEditor surface="settings" onSaved={() => { setEditing(false); setHasPassword(true); setMessage('Password saved. You can now sign in with your email and password.'); }} />
      <button type="button" className="mt-3 min-h-11 text-sm underline" onClick={() => { posthog.capture('auth_set_password_canceled'); setEditing(false); }}>Cancel</button></>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    {error && hasPassword === null && <button type="button" className="mt-2 min-h-11 underline" onClick={() => { posthog.capture('auth_password_settings_retry'); setAttempt(n => n + 1); }}>Try again</button>}
    {message && <p role="status" className="mt-3 text-sm text-green-800">{message}</p>}
  </section>;
}
