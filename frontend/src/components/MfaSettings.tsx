import React, { useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { AuthenticatorCodeForm } from './AuthenticatorCodeForm';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { accountMfaEnabled } from '../services/accountMfa';

type Factor = { id: string; friendly_name?: string };
type Setup = { id: string; qr_code: string; secret: string };

export function MfaSettings() {
  const { user } = useAuth();
  const active = accountMfaEnabled() && Boolean(user && !user.is_anonymous);
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active) return;
    let mounted = true;
    setError('');
    void supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (!mounted) return;
      if (error || !data) { setError('Could not load your authenticators.'); return; }
      setFactors(data.totp);
    }).catch(() => { if (mounted) setError('Could not load your authenticators.'); });
    return () => { mounted = false; };
  }, [active, user?.id, revision]);

  if (!active) return null;
  const start = async () => {
    setBusy(true);
    setError('');
    posthog.capture('account_mfa_setup_started');
    try {
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'BrickBuilder' });
      if (error || !data) throw error;
      setSetup({ id: data.id, qr_code: data.totp.qr_code, secret: data.totp.secret });
    } catch { setError('Could not start authenticator setup. Please try again.'); }
    finally { setBusy(false); }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
      if (error) throw error;
      if (setup?.id === id) {
        setSetup(null);
      } else {
        posthog.capture('account_mfa_authenticator_removed');
        setRemoveId(null);
        setRevision(value => value + 1);
      }
    } catch { setError('Could not remove the authenticator. Please try again.'); }
    finally { setBusy(false); }
  };

  return <section className="mb-4 max-w-2xl rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
    <h2 className="text-lg font-semibold text-slate-900">Two-factor authentication</h2>
    <p className="mt-1 text-sm text-slate-600">{factors?.length ? 'On. Sign-ins require a code from an authenticator app.' : 'Add an authenticator app to protect your account with a six-digit code.'}</p>
    {factors && !setup && !removeId && <button className="mt-2 min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium" disabled={busy} onClick={() => void start()}>
      {factors.length ? 'Add another authenticator' : 'Turn on MFA'}
    </button>}
    {factors && !setup && <ul className="mt-3 space-y-2">
      {factors.map((factor, index) => <li key={factor.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>{factor.friendly_name || `Authenticator ${index + 1}`}</span>
        {removeId === factor.id ? <div className="flex flex-wrap gap-3">
          <button className="min-h-11 text-red-700 underline" disabled={busy} onClick={() => void remove(factor.id)}>
            {factors.length === 1 ? 'Turn off MFA' : 'Confirm removal'}
          </button>
          <button className="min-h-11 underline" disabled={busy} onClick={() => setRemoveId(null)}>Cancel</button>
        </div> : <button className="min-h-11 underline" disabled={busy || Boolean(removeId)} onClick={() => setRemoveId(factor.id)}>
          Remove {factor.friendly_name || `Authenticator ${index + 1}`}
        </button>}
      </li>)}
    </ul>}
    {setup && <div className="mt-4 max-w-sm ph-no-capture">
      <p className="text-sm text-slate-700">Scan this QR code in your authenticator app or enter the setup key.</p>
      <img className="my-3 h-40 w-40" src={setup.qr_code} alt="Authenticator setup QR code" />
      <p className="mb-3 ph-mask break-all rounded-lg bg-slate-100 p-2 font-mono text-xs">{setup.secret}</p>
      <AuthenticatorCodeForm factorId={setup.id} onBusyChange={setVerifying} onVerified={() => {
        posthog.capture('account_mfa_enabled');
        setSetup(null);
        setRevision(value => value + 1);
      }} />
      <button className="mt-2 min-h-11 text-sm underline" disabled={busy || verifying} onClick={() => void remove(setup.id)}>Cancel setup</button>
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {error && !factors && <button className="min-h-11 text-sm underline" onClick={() => setRevision(value => value + 1)}>Try again</button>}
  </section>;
}
