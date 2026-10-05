import React, { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ExternalLink, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import posthog from 'posthog-js';
import { LocalProvidersApiService, safeProviderLoginUrl, type LocalProviderId, type LocalProviderStatus } from '../services/localProvidersApi';

const PROVIDER_LABELS: Record<LocalProviderId, string> = { openai: 'ChatGPT / OpenAI', anthropic: 'Claude / Anthropic', fal: 'fal.ai' };
const LOGIN_LABELS: Record<LocalProviderId, string> = { openai: 'Sign in to ChatGPT', anthropic: 'Sign in to Claude', fal: 'Sign in to fal.ai' };

export function LocalProviderSettings() {
  const [open, setOpen] = useState(false);
  const [providers, setProviders] = useState<LocalProviderStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<LocalProviderId | null>(null);
  const hasPending = providers.some(provider => ['starting', 'pending'].includes(provider.login.status));

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void LocalProvidersApiService.getStatus(controller.signal)
      .then(data => { if (!controller.signal.aborted) setProviders(data.providers); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load provider connections'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (!open || !hasPending) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void LocalProvidersApiService.getStatus(controller.signal)
        .then(data => { if (!controller.signal.aborted) { setProviders(data.providers); setError(''); } })
        .catch(() => { if (!controller.signal.aborted) setError('Waiting to reconnect to the local server…'); });
    }, 2000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [open, hasPending]);

  const update = async (provider: LocalProviderId, action: () => Promise<LocalProviderStatus>) => {
    setBusy(provider);
    setError('');
    try {
      const status = await action();
      setProviders(current => current.map(row => row.id === provider ? status : row));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update provider connection');
    } finally { setBusy(null); }
  };

  return <section aria-label="Local provider connections" className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white text-left shadow-sm">
    <button type="button" aria-expanded={open} onClick={() => {
      posthog.capture('landing_local_connections_toggled', { expanded: !open });
      setOpen(current => !current);
    }} className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
      <span className="flex items-center gap-2"><KeyRound aria-hidden="true" className="h-4 w-4 text-slate-500" /> Local provider connections</span>
      <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div className="space-y-4 border-t border-slate-100 p-4">
      <p className="text-xs leading-5 text-slate-500">Connect your local accounts. ChatGPT and Claude sessions use the local agent tools. fal.ai sign in creates and attaches an API key for SAM3D and Trellis. Project keys stay on the local server.</p>
      {loading && <p role="status" className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking connections…</p>}
      {error && <p role="alert" className="break-words rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-800">{error}</p>}
      {providers.map(provider => <ProviderConnection key={provider.id} provider={provider} disabled={busy !== null} busy={busy === provider.id} onAction={action => update(provider.id, action)} />)}
      <button type="button" disabled={loading || busy !== null} className="inline-flex min-h-10 items-center gap-2 rounded-full px-3 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50" onClick={async () => {
        posthog.capture('landing_local_connections_refreshed');
        setLoading(true);
        try { setProviders((await LocalProvidersApiService.getStatus()).providers); setError(''); }
        catch { setError('Unable to refresh connections. Check the local server and try again.'); }
        finally { setLoading(false); }
      }}><RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Refresh connections</button>
    </div>}
  </section>;
}

function ProviderConnection({ provider, disabled, busy, onAction }: {
  provider: LocalProviderStatus;
  disabled: boolean;
  busy: boolean;
  onAction: (action: () => Promise<LocalProviderStatus>) => Promise<void>;
}) {
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [claudeCodeOpen, setClaudeCodeOpen] = useState(false);
  const [claudeCode, setClaudeCode] = useState('');
  const pending = ['starting', 'pending'].includes(provider.login.status);
  const loginUrl = safeProviderLoginUrl(provider.id, provider.login.url);
  const connected = provider.id === 'fal' ? provider.api_key_configured : provider.cli_connected;
  return <div className="min-w-0 rounded-xl border border-slate-200 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-slate-800">{PROVIDER_LABELS[provider.id]}</h3>
      <span className={`inline-flex items-center gap-1.5 text-xs ${connected || provider.api_key_configured ? 'text-emerald-700' : 'text-slate-500'}`}>
        {(connected || provider.api_key_configured) && <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />}
        {connected ? provider.id === 'fal' ? 'Project key attached' : 'Account connected' : provider.api_key_configured ? 'Project API key attached' : 'Not connected'}
      </span>
    </div>
    {provider.id !== 'fal' && provider.api_key_configured && connected && <p className="mt-1 text-xs text-slate-500">Project API key also attached</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={disabled || pending || !provider.cli_available} onClick={() => {
        posthog.capture('landing_local_provider_login_clicked', { provider: provider.id });
        void onAction(() => LocalProvidersApiService.login(provider.id));
      }} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-slate-300 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
        {(busy || pending) && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
        {pending ? 'Waiting for sign in…' : LOGIN_LABELS[provider.id]}
      </button>
      <button type="button" disabled={disabled} onClick={() => {
        posthog.capture('landing_local_provider_key_form_toggled', { provider: provider.id, expanded: !keyFormOpen });
        setKeyFormOpen(current => !current); setApiKey('');
      }} className="min-h-10 rounded-full px-3 py-2 text-xs text-slate-600 hover:bg-slate-100 disabled:opacity-50">{keyFormOpen ? 'Close API key' : 'Use API key'}</button>
      {pending && <button type="button" disabled={disabled} onClick={() => {
        posthog.capture('landing_local_provider_login_cancelled', { provider: provider.id });
        void onAction(() => LocalProvidersApiService.cancelLogin(provider.id));
      }} className="min-h-10 rounded-full px-3 text-xs text-slate-500 hover:bg-slate-100">Cancel sign in</button>}
    </div>
    {!provider.cli_available && provider.install_hint && <p className="mt-2 break-words text-xs leading-5 text-slate-500">{provider.install_hint}</p>}
    {provider.login.message && <p role="status" className="mt-2 break-words text-xs leading-5 text-slate-600">{provider.login.message}</p>}
    {pending && provider.login.code && <p className="mt-2 text-xs text-slate-600">Sign in code: <code className="ph-no-capture select-all rounded bg-slate-100 px-2 py-1 font-semibold">{provider.login.code}</code></p>}
    {pending && loginUrl && <a href={loginUrl} target="_blank" rel="noopener noreferrer" onClick={() => posthog.capture('landing_local_provider_login_page_opened', { provider: provider.id })} className="ph-no-capture mt-2 inline-flex min-h-10 items-center gap-1.5 text-xs font-medium text-red-600 hover:underline">Continue in browser <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a>}
    {provider.id === 'anthropic' && pending && <div className="mt-2">
      <button type="button" disabled={disabled} onClick={() => {
        posthog.capture('landing_local_claude_code_form_toggled', { expanded: !claudeCodeOpen });
        setClaudeCodeOpen(current => !current); setClaudeCode('');
      }} className="min-h-10 text-xs text-slate-500 hover:underline">{claudeCodeOpen ? 'Close sign in code' : 'Browser gave you a sign in code?'}</button>
      {claudeCodeOpen && <form className="mt-2 flex flex-col gap-2 sm:flex-row" onSubmit={event => {
        event.preventDefault();
        if (!claudeCode.trim() || disabled) return;
        posthog.capture('landing_local_claude_code_submitted');
        const submittedCode = claudeCode; setClaudeCode('');
        void onAction(() => LocalProvidersApiService.submitClaudeCode(submittedCode));
      }}>
        <input aria-label="Claude sign in code" type="password" autoComplete="off" spellCheck={false} data-private="true" className="ph-no-capture min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-100" value={claudeCode} onFocus={() => posthog.capture('landing_local_claude_code_focused')} onChange={event => setClaudeCode(event.target.value)} disabled={disabled} placeholder="Paste the code from Claude" />
        <button type="submit" disabled={disabled || !claudeCode.trim()} className="min-h-10 rounded-full bg-slate-900 px-4 text-xs font-medium text-white disabled:opacity-50">Complete sign in</button>
      </form>}
    </div>}
    {keyFormOpen && <form className="mt-3 space-y-2 border-t border-slate-100 pt-3" onSubmit={event => {
      event.preventDefault();
      if (!apiKey.trim() || disabled) return;
      posthog.capture('landing_local_provider_key_saved', { provider: provider.id });
      const submittedKey = apiKey; setApiKey('');
      void onAction(() => LocalProvidersApiService.saveApiKey(provider.id, submittedKey));
    }}>
      <label htmlFor={`local-key-${provider.id}`} className="block text-xs text-slate-600">Project API key</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id={`local-key-${provider.id}`} type="password" value={apiKey} autoComplete="off" spellCheck={false} data-private="true" className="ph-no-capture min-h-10 min-w-0 flex-1 rounded-lg border border-slate-300 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-red-100" onFocus={() => posthog.capture('landing_local_provider_key_input_focused', { provider: provider.id })} onChange={event => setApiKey(event.target.value)} placeholder="Paste API key" disabled={disabled} />
        <button type="submit" disabled={disabled || !apiKey.trim()} className="min-h-10 rounded-full bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50">Attach key</button>
      </div>
      {provider.api_key_configured && <button type="button" disabled={disabled} onClick={() => {
        posthog.capture('landing_local_provider_key_removed', { provider: provider.id });
        setApiKey(''); void onAction(() => LocalProvidersApiService.removeApiKey(provider.id));
      }} className="min-h-10 text-xs text-red-600 hover:underline disabled:opacity-50">Remove project API key</button>}
    </form>}
  </div>;
}
