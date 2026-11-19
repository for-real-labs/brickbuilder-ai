import React, { useId, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { verifyAuthenticator } from '../services/accountMfa';

export function AuthenticatorCodeForm({ factorId, onVerified, onBusyChange }: {
  factorId: string; onVerified: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !/^\d{6}$/.test(code)) return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError('');
    posthog.capture('account_mfa_code_submitted');
    try {
      await verifyAuthenticator(factorId, code);
      onVerified();
    } catch {
      setError('That code could not be verified. Try the latest code from your authenticator.');
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return <form className="space-y-3" onSubmit={submit}>
    <label className="block text-sm font-medium text-slate-700" htmlFor={id}>Authenticator code</label>
    <input className="input ph-no-capture h-11 w-full rounded-lg" id={id} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
      autoComplete="one-time-code" inputMode="numeric" required pattern="[0-9]{6}" disabled={busy} />
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <button className="min-h-11 w-full rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={busy || code.length !== 6}>
      {busy ? 'Verifying…' : 'Verify code'}
    </button>
  </form>;
}
