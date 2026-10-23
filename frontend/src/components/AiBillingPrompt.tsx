import React, { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { PetChatMessage } from './PetCompanion';
import { AiBillingSettings } from './AiBillingSettings';
import { providerKeysApi, type PersonalBillingConfirmation } from '../services/providerKeysApi';

export function AiBillingPrompt() {
  const { user } = useAuth();
  const [mode, setMode] = useState<'offer' | 'settings' | 'confirm' | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<PersonalBillingConfirmation | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const finish = (answer = false) => { pending.current?.resolve(answer); pending.current = null; setMode(null); setError(''); };
  useEffect(() => {
    const offer = () => { setMode('offer'); posthog.capture('ai_billing_credit_offer_shown'); };
    const settings = () => setMode('settings');
    const confirm = (event: Event) => {
      pending.current?.resolve(false);
      pending.current = (event as CustomEvent<PersonalBillingConfirmation>).detail;
      setMode('confirm'); posthog.capture('ai_billing_confirmation_shown');
    };
    window.addEventListener('brickbuilder:credits-required', offer);
    window.addEventListener('brickbuilder:open-ai-billing', settings);
    window.addEventListener('brickbuilder:confirm-personal-billing', confirm);
    return () => {
      pending.current?.resolve(false);
      window.removeEventListener('brickbuilder:credits-required', offer);
      window.removeEventListener('brickbuilder:open-ai-billing', settings);
      window.removeEventListener('brickbuilder:confirm-personal-billing', confirm);
    };
  }, []);
  useEffect(() => { finish(); }, [user?.id]);
  useEffect(() => { if (mode) dialog.current?.showModal(); }, [mode]);
  const answer = async (yes: boolean, remember = false) => {
    posthog.capture('ai_billing_confirmation_answered', { continue: yes, remember });
    if (remember) {
      setBusy(true);
      try { await providerKeysApi.preferences({ billing_source: 'personal', skip_confirmation: true }); }
      catch { setError('Could not save your preference. Try Continue instead.'); setBusy(false); return; }
      setBusy(false);
    }
    finish(yes);
  };
  return mode ? <dialog ref={dialog} aria-label="AI billing" className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-xl backdrop:bg-black/40 sm:p-6"
    onCancel={event => { event.preventDefault(); finish(); }}>
    <PetChatMessage>
      {mode === 'offer' ? <><p>You’re out of BrickBuilder credits.</p><p className="mt-2">You can keep building with no BrickBuilder credit limit using your own OpenAI or Claude API keys. Your provider bills you for usage. Want to add your keys?</p></>
        : mode === 'confirm' ? <p>You’re using your own AI billing for this generation. Your provider will charge your API account. Want to continue?</p>
          : <p>Add your API key below, then choose “My API keys” to use it for builds.</p>}
    </PetChatMessage>
    {mode === 'settings' && <AiBillingSettings key={user?.id || 'guest'} />}
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      {mode === 'offer' && <button type="button" className="pet-chat-action" onClick={() => { posthog.capture('ai_billing_credit_offer_accepted'); setMode('settings'); }}>Yes, add API keys</button>}
      {mode === 'confirm' && <><button type="button" disabled={busy} className="pet-chat-action" onClick={() => void answer(true)}>Continue</button>
        <button type="button" disabled={busy} className="pet-chat-action" onClick={() => void answer(true, true)}>Continue & don’t ask again</button></>}
      <button type="button" disabled={busy} className="pet-chat-action" onClick={() => { posthog.capture('ai_billing_prompt_dismissed', { mode }); finish(); }}>{mode === 'settings' ? 'Done' : 'No'}</button>
    </div>
  </dialog> : null;
}
