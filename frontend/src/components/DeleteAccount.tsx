import React, { useState } from 'react';
import posthog from 'posthog-js';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { authenticatedApiFetch } from '../services/apiFetch';
import { readApiError } from '../services/apiError';

const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002'
  : mode === 'railway_staging' ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
  : import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';

export function DeleteAccount() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    if (busy || confirmation !== 'DELETE') return;
    setBusy(true); setError('');
    posthog.capture('account_deletion_confirmed');
    try {
      const response = await authenticatedApiFetch(`${base}/account/delete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      setDeleted(true);
      navigate('/account-deleted', { replace: true });
      posthog.reset();
      // Clear the local session even though the server has already revoked it.
      await supabase.auth.signOut({ scope: 'local' });
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete your account. Please retry.'); }
    finally { setBusy(false); }
  };
  if (deleted) return <section role="status" className="mt-6 max-w-2xl rounded-xl border border-slate-200 bg-white p-5">
    <h2 className="text-lg font-semibold">Account deleted</h2><p>Your account has been permanently deleted.</p>
    <a href="/" className="inline-block py-3 underline">Return to BrickBuilder</a>
  </section>;
  return <section className="mt-6 max-w-2xl rounded-xl border border-red-200 bg-white p-5 sm:p-6" aria-label="Delete account">
    <h2 className="text-lg font-semibold text-slate-900">Delete account</h2>
    <p className="mt-2 text-sm text-slate-600">Permanently delete your account, saved models, community posts, settings, and unused credits. This cannot be undone.</p>
    {!open ? <button type="button" className="mt-4 min-h-11 rounded-lg border border-red-300 px-4 text-red-700" onClick={() => {
      posthog.capture('account_deletion_opened'); setOpen(true);
    }}>Delete my account</button> : <div className="mt-4 space-y-4">
      <p className="text-sm text-slate-600">Web subscriptions will be canceled. Apple subscriptions must be canceled separately in <a href="https://apps.apple.com/account/subscriptions" className="underline" onClick={() => posthog.capture('account_deletion_apple_subscriptions_clicked')}>Apple subscription settings</a>. Deleting your account does not cancel Apple billing.</p>
      <p className="text-sm text-slate-600">Physical order records and the models needed to fulfill them are retained for fulfillment and financial records. A security record prevents deleted accounts from being reused. Other account data is deleted.</p>
      <label className="block text-sm font-medium" htmlFor="delete-account-confirmation">Type DELETE to confirm</label>
      <input id="delete-account-confirmation" autoComplete="off" value={confirmation} disabled={busy} onChange={e => setConfirmation(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-3 text-base" />
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" disabled={busy || confirmation !== 'DELETE'} className="min-h-11 rounded-lg bg-red-700 px-4 text-white disabled:opacity-40" onClick={() => void remove()}>{busy ? 'Deleting…' : 'Permanently delete account'}</button>
        <button type="button" disabled={busy} className="min-h-11 rounded-lg border border-slate-300 px-4" onClick={() => { posthog.capture('account_deletion_canceled'); setOpen(false); setConfirmation(''); setError(''); }}>Keep account</button>
      </div>
    </div>}
  </section>;
}
