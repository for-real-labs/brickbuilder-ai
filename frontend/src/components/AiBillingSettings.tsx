import React, { useEffect, useId, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { providerKeysApi, type AiBillingSettings as Settings, type AiProvider } from '../services/providerKeysApi';

export function AiBillingSettings() {
  const { user } = useAuth();
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keys, setKeys] = useState({ openai: '', anthropic: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setSettings(null); setKeys({ openai: '', anthropic: '' }); setError('');
    if (user) void providerKeysApi.status().then(value => { if (active) setSettings(value); }).catch(() => { if (active) setError('Could not load AI billing settings. Reopen settings to retry.'); });
    return () => { active = false; };
  }, [user?.id]);
  const update = async (action: () => Promise<Settings>, event: string, provider?: AiProvider) => {
    setBusy(true); setError('');
    posthog.capture(event, { provider });
    try { setSettings(await action()); window.dispatchEvent(new Event('brickbuilder:ai-billing-changed')); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update AI billing.'); }
    finally { setBusy(false); }
  };
  return <section aria-label="AI billing settings" className="my-4 min-w-0 rounded-2xl border border-slate-200 bg-white p-4 text-left sm:p-5">
    <h2 className="text-base font-semibold text-slate-900">AI billing & API keys</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600">Use your own OpenAI or Claude API key to use BrickBuilder for free.</p>
    {!user ? <a href="/login" className="mt-3 inline-block text-sm font-medium text-red-700" onClick={() => posthog.capture('ai_billing_sign_in_clicked')}>Sign in to save your keys</a> : <>
      {settings && <label className="mt-4 block text-sm font-medium text-slate-700">Pay for builds with
        <select aria-label="AI billing source" value={settings.billing_source} disabled={busy} className="mt-2 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3"
          onChange={e => { const billing_source = e.target.value as Settings['billing_source']; void update(() => providerKeysApi.preferences({ billing_source, skip_confirmation: settings.skip_confirmation }), 'ai_billing_source_changed'); }}>
          <option value="brickbuilder">BrickBuilder credits</option><option value="personal">My API keys</option>
        </select>
      </label>}
      {(['openai', 'anthropic'] as const).map(provider => <div key={provider} className="mt-4 rounded-xl bg-slate-50 p-3">
        <label htmlFor={`${id}-${provider}`} className="block text-sm font-medium text-slate-800">{provider === 'openai' ? 'OpenAI' : 'Claude / Anthropic'} API key {settings?.providers.includes(provider) && <span className="ml-1 text-xs text-emerald-700">Saved securely</span>}</label>
        <input id={`${id}-${provider}`} type="password" autoComplete="off" spellCheck={false} data-private="true" className="ph-no-capture mt-2 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 px-3 text-sm" placeholder="Paste API key" value={keys[provider]} disabled={busy || !settings}
          onChange={e => setKeys(current => ({ ...current, [provider]: e.target.value }))} />
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" disabled={busy || !settings || !keys[provider].trim()} className="min-h-11 rounded-full bg-slate-900 px-4 text-sm font-medium text-white disabled:opacity-40"
            onClick={() => { const key = keys[provider].trim(); setKeys(current => ({ ...current, [provider]: '' })); void update(() => providerKeysApi.save(provider, key), 'ai_provider_key_saved', provider); }}>Save key</button>
          {settings?.providers.includes(provider) && <button type="button" disabled={busy} className="min-h-11 rounded-full px-4 text-sm text-red-700" onClick={() => void update(() => providerKeysApi.remove(provider), 'ai_provider_key_removed', provider)}>Remove key</button>}
        </div>
      </div>)}
      {settings && <label className="mt-4 flex min-h-11 items-center gap-3 text-sm text-slate-700"><input type="checkbox" checked={!settings.skip_confirmation} disabled={busy}
        onChange={e => { const skip_confirmation = !e.target.checked; void update(() => providerKeysApi.preferences({ billing_source: settings.billing_source, skip_confirmation }), 'ai_billing_confirmation_changed'); }} />Ask before charging my AI account</label>}
      <p className="mt-3 text-xs leading-5 text-slate-500">Keys are encrypted on the backend and are never displayed again. Add a key for the provider of your selected model. Image-to-3D services still use BrickBuilder credits.</p>
    </>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
  </section>;
}
