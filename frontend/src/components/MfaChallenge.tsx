import React, { useEffect, useState } from 'react';
import { AuthenticatorCodeForm } from './AuthenticatorCodeForm';
import { supabase } from '../lib/supabase';

export function MfaChallenge({ unavailable, onRetry, onSignOut }: {
  unavailable: boolean; onRetry: () => void; onSignOut: () => void;
}) {
  const [factors, setFactors] = useState<{ id: string; friendly_name?: string }[]>([]);
  const [factorId, setFactorId] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (unavailable) return;
    let active = true;
    setError(false);
    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (!active) return;
      if (error || !data?.totp.length) { setError(true); return; }
      setFactors(data.totp);
      setFactorId(data.totp[0].id);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [unavailable, attempt]);
  return <main className="mx-auto mt-12 w-[calc(100%_-_2rem)] max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
    <h1 className="text-xl font-semibold text-slate-900">Verify your sign-in</h1>
    <p className="mb-4 mt-2 text-sm text-slate-600">Enter the six-digit code from your authenticator app.</p>
    {factors.length > 1 && <label className="mb-3 block text-sm">Authenticator
      <select className="input mt-1 h-11 w-full" value={factorId} disabled={busy} onChange={event => setFactorId(event.target.value)}>
        {factors.map((factor, index) => <option key={factor.id} value={factor.id}>{factor.friendly_name || `Authenticator ${index + 1}`}</option>)}
      </select>
    </label>}
    {unavailable || error ? <>
      <p role="alert" className="text-sm text-red-700">Could not check your sign-in. Try again.</p>
      <button className="min-h-11 underline" onClick={() => unavailable ? onRetry() : setAttempt(value => value + 1)}>Try again</button>
    </> : factorId ? <AuthenticatorCodeForm key={factorId} factorId={factorId} onBusyChange={setBusy} onVerified={onRetry} />
      : <p role="status" className="text-sm text-slate-600">Loading your authenticators…</p>}
    <button className="mt-2 min-h-11 text-sm text-slate-700 underline" disabled={busy} onClick={onSignOut}>Sign out</button>
  </main>;
}
