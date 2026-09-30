import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { ShieldCheck, Blocks } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type AuthorizationDetails = {
  client: { id: string; name: string; uri?: string };
  scope: string;
  redirect_uri: string;
};

export default function OAuthConsentPage() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  const authorizationId = params.get('authorization_id');
  const [details, setDetails] = useState<AuthorizationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setError(null);
    if (!authorizationId || !user || !isSupabaseConfigured) return;
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: authError }) => {
      if (!active) return;
      if (authError || !data) {
        setError('This connection request is invalid or expired. Start again from your AI app.');
      } else if ('client' in data) {
        setDetails(data);
      } else {
        // Supabase returns this only when the user has already granted consent.
        // Trust the provider's callback, never a redirect query parameter.
        const redirect = new URL(data.redirect_url);
        if (redirect.protocol !== 'https:') throw new Error('Invalid callback');
        window.location.assign(redirect.href);
      }
    }).catch(() => {
      if (active) setError('Unable to load the connection request. Please try again.');
    });
    return () => { active = false; };
  }, [authorizationId, user]);

  async function decide(approve: boolean) {
    if (!authorizationId || !details || busy) return;
    setBusy(true);
    setError(null);
    posthog.capture('mcp_connection_decision', { approved: approve, client_id: details.client.id });
    try {
      const { data, error: authError } = approve
        ? await supabase.auth.oauth.approveAuthorization(authorizationId, { skipBrowserRedirect: true })
        : await supabase.auth.oauth.denyAuthorization(authorizationId, { skipBrowserRedirect: true });
      if (authError || !data?.redirect_url) throw new Error('Authorization failed');
      // Only follow the registered callback returned by Supabase, never a URL
      // supplied in this page's query string.
      const redirect = new URL(data.redirect_url);
      const registered = new URL(details.redirect_uri);
      if (redirect.protocol !== 'https:' || redirect.origin !== registered.origin || redirect.pathname !== registered.pathname) {
        throw new Error('Invalid authorization callback');
      }
      window.location.assign(redirect.href);
    } catch {
      setError('Unable to finish connecting. Please start again from your AI app.');
      setBusy(false);
    }
  }

  if (!loading && !user && authorizationId && isSupabaseConfigured) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-12 sm:py-20">
      <div className="mx-auto w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <Link to="/" onClick={() => posthog.capture('mcp_consent_home_clicked')} className="mb-8 inline-flex items-center gap-2 text-lg font-extrabold tracking-tight">
          <Blocks className="text-[#ff4b4b]" aria-hidden="true" /> BRICKBUILDER
        </Link>
        <ShieldCheck className="mb-4 h-9 w-9 text-slate-700" aria-hidden="true" />
        <h1 className="text-2xl font-bold text-slate-900">Connect your AI app</h1>
        {!authorizationId || !isSupabaseConfigured ? (
          <p role="alert" className="mt-4 text-slate-600">Start a connection from ChatGPT or Claude to link your BrickBuilder account.</p>
        ) : loading || (!details && !error) ? (
          <p role="status" className="mt-4 text-slate-600">Loading connection request…</p>
        ) : details ? (
          <>
            <p className="mt-3 break-words text-slate-600"><strong className="text-slate-900">{details.client.name}</strong> wants to connect to your BrickBuilder account{user?.email ? ` (${user.email})` : ''}.</p>
            <ul className="mt-6 space-y-3 text-sm text-slate-700">
              <li>Generate LEGO models from your descriptions and edit your saved models.</li>
              <li>Read your model progress, previews, LDraw files, parts lists, and credit balance.</li>
              <li>Use one account credit for each successful AI generation or edit. Checking progress is free.</li>
            </ul>
            <p className="mt-5 break-words text-xs text-slate-500">Requested account information: {details.scope || 'basic account identity'}. You can disconnect this service in your AI app.</p>
            <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row">
              <button disabled={busy} onClick={() => decide(false)} className="rounded-lg border border-slate-300 px-5 py-3 text-sm font-semibold disabled:opacity-50">Cancel</button>
              <button disabled={busy} onClick={() => decide(true)} className="flex-1 rounded-lg bg-[#ff4b4b] px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Connecting…' : 'Allow connection'}</button>
            </div>
          </>
        ) : null}
        {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      </div>
    </main>
  );
}
