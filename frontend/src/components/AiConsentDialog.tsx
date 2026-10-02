import React, { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { AI_CONSENT_VERSION, AI_PROVIDERS, AI_SHARED_DATA, hasAiConsent, registerAiConsentPrompt, saveAiConsent } from '../utils/aiConsent';

export function AiConsentDialog() {
  const dialog = useRef<HTMLDialogElement>(null);
  const resolve = useRef<((allowed: boolean) => void)[]>([]);
  const [open, setOpen] = useState(false);
  const [previouslyAllowed, setPreviouslyAllowed] = useState(false);

  useEffect(() => {
    const unregister = registerAiConsentPrompt(() => new Promise<boolean>(done => {
      resolve.current.push(done);
      setPreviouslyAllowed(hasAiConsent());
      setOpen(true);
      posthog.capture('ai_consent_shown', { consent_version: AI_CONSENT_VERSION });
    }));
    return () => {
      unregister();
      resolve.current.splice(0).forEach(done => done(false));
    };
  }, []);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const choose = (allowed: boolean) => {
    saveAiConsent(allowed);
    posthog.capture('ai_consent_decision', { allowed, consent_version: AI_CONSENT_VERSION });
    setOpen(false);
    resolve.current.splice(0).forEach(done => done(allowed));
  };

  return (
    <dialog ref={dialog} aria-labelledby="ai-consent-title" aria-describedby="ai-consent-description"
      onCancel={event => { event.preventDefault(); choose(false); }}
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 sm:p-8">
      <h2 id="ai-consent-title" className="text-2xl font-bold">Allow AI processing?</h2>
      <div id="ai-consent-description" className="mt-4 space-y-4 text-sm leading-6 text-slate-600">
        <p>BrickBuilder uses third-party AI services to create and edit models and suggest model titles.</p>
        <p><strong className="text-slate-900">What is shared:</strong> {AI_SHARED_DATA} This includes any personal information you put in that content.</p>
        <p><strong className="text-slate-900">Who receives it:</strong> {AI_PROVIDERS}, depending on the feature and model selected. These services process your content to fulfill your request.</p>
        <p>Only share content you are comfortable sending to these providers. You can decline and still browse models or order physical bricks. Withdraw permission anytime under <strong>AI privacy</strong> in the footer. Withdrawal stops future requests; it does not undo processing already started.</p>
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-semibold text-[#c62828] underline"
          onClick={() => posthog.capture('ai_consent_privacy_policy_clicked')}>Read the Privacy Policy</a>
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button type="button" onClick={() => choose(false)} className="min-h-12 flex-1 rounded-xl border border-slate-300 px-4 py-3 font-semibold hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          {previouslyAllowed ? 'Withdraw permission' : 'Don’t allow'}
        </button>
        <button type="button" onClick={() => choose(true)} className="min-h-12 flex-1 rounded-xl bg-[#f44336] px-4 py-3 font-semibold text-white hover:bg-[#d32f2f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
          Allow AI processing
        </button>
      </div>
    </dialog>
  );
}
