import React, { useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { PasswordEditor } from '../components/PasswordEditor';
import { PasswordRecovery } from '../components/PasswordRecovery';

// Capture callback errors before the Auth SDK removes the fragment.
const callbackParams = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.hash.slice(1));
const callbackSearch = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
const callbackError = [callbackParams, callbackSearch].some(params => params.has('error') || params.has('error_code'));
export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [email, setEmail] = useState('');
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (active) { setReady(!callbackError && !error && Boolean(data.session)); setLoading(false); }
    }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  return <main className="mx-auto w-full max-w-md px-5 py-12">
    <Link to="/" className="text-lg font-bold" onClick={() => posthog.capture('auth_recovery_home_clicked')}>BrickBuilder</Link>
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-bold">{saved ? 'Password saved' : 'Choose a new password'}</h1>
      {loading ? <p role="status" className="mt-4">Checking your reset link…</p> : saved ? <>
        <p role="status" className="mt-4 text-slate-600">Your password has been updated. Use it to sign in on any device.</p>
        <Link to="/dashboard?tab=settings" className="mt-5 inline-block min-h-11 py-3 text-[#c83228] underline" onClick={() => posthog.capture('auth_recovery_continue_clicked')}>Continue to your account</Link>
      </> : ready ? <PasswordEditor surface="recovery" onSaved={() => setSaved(true)} /> : <>
        <p className="mt-4 text-sm text-slate-600">This reset link is missing, expired, or already used. Request a new link below.</p>
        <label className="mt-4 block text-sm font-medium">Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-3 text-base" /></label>
        <PasswordRecovery email={email} surface="recovery" />
      </>}
    </section>
  </main>;
}
