import React, { useState } from 'react';
import posthog from 'posthog-js';
import { saveAccountPassword } from '../services/passwordAuth';

export function PasswordEditor({ onSaved, surface }: { onSaved: () => void; surface: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (password.length < 8) { setError('Use at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    posthog.capture('auth_password_save_submitted', { surface });
    try {
      await saveAccountPassword(password);
      setPassword(''); setConfirm('');
      posthog.capture('auth_password_saved', { surface });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your password. Please try again.');
    } finally { setBusy(false); }
  };
  return <form onSubmit={submit} className="mt-4 space-y-4">
    <label className="block text-sm font-medium">New password
      <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base" type="password" autoComplete="new-password" minLength={8} required disabled={busy} value={password} onChange={e => setPassword(e.target.value)} />
    </label>
    <p className="text-sm text-slate-500">Use at least 8 characters.</p>
    <label className="block text-sm font-medium">Confirm new password
      <input className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base" type="password" autoComplete="new-password" minLength={8} required disabled={busy} value={confirm} onChange={e => setConfirm(e.target.value)} />
    </label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button type="submit" disabled={busy} className="min-h-11 rounded-lg bg-[#e94439] px-5 text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save password'}</button>
  </form>;
}
