import React, { useEffect, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { GenerationEmailApi } from '../services/generationEmailApi';
import { CancelGenerationButton } from './CancelGenerationButton';
import { GenerationElapsedTime } from './GenerationElapsedTime';

/** Actions while a new build or model edit runs in the background. */
export function PendingEditActions({ generationId, startedAt, onCancelled, onStartNew, isEdit = true }: {
  generationId: string | null;
  startedAt?: string;
  onCancelled: () => void;
  onStartNew: () => void;
  isEdit?: boolean;
}) {
  const { session } = useAuth();
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [subscribed, setSubscribed] = useState(false);
  const [recipient, setRecipient] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!generationId) return;
    const controller = new AbortController();
    void GenerationEmailApi.status(generationId, controller.signal)
      .then(result => { if (!controller.signal.aborted) {
        setSubscribed(current => current || result.subscribed);
        if (result.email) setRecipient(result.email);
      } })
      .catch(() => {});
    return () => controller.abort();
  }, [generationId]);

  const subscribe = async () => {
    if (!generationId || saving || subscribed) return;
    setSaving(true);
    setError(null);
    const properties = { generation_id: generationId, source: isEdit ? 'landing_edit_actions' : 'landing_generation_actions', is_authenticated: Boolean(session) };
    posthog.capture('generation_email_notification_requested', properties);
    try {
      const result = await GenerationEmailApi.subscribe(generationId, session ? undefined : email.trim());
      if (!result.subscribed) throw new Error('Could not save your email. Please try again.');
      setSubscribed(true);
      setRecipient(result.email);
      setEmailOpen(false);
      posthog.capture('generation_email_notification_subscribed', properties);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your email. Please try again.');
    } finally { setSaving(false); }
  };

  const buttonClass = 'min-h-11 min-w-0 rounded-full border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm';
  return <div className="mb-3 w-full" aria-label="Generation in progress actions">
    <GenerationElapsedTime startedAt={startedAt} />
    <p className="mb-3 text-sm leading-6 text-slate-700">
      {subscribed ? recipient ? `Email will be sent to ${recipient} when ready.` : 'Email will be sent when ready.'
        : 'This can take up to 30 minutes. Do you want an email when it’s ready?'}
    </p>
    {emailOpen && !subscribed && <form className="mb-3 flex gap-2" onSubmit={event => { event.preventDefault(); void subscribe(); }}>
      <label className="sr-only" htmlFor="landing-generation-email">Email address</label>
      <input id="landing-generation-email" type="email" autoComplete="email" required maxLength={254} autoFocus
        value={email} onChange={event => setEmail(event.target.value)} disabled={saving}
        placeholder="you@example.com" className="min-h-11 min-w-0 flex-1 rounded-full border border-slate-300 bg-white px-4 text-sm focus:border-[#f44336] focus:outline-none" />
      <button type="submit" disabled={saving} className={buttonClass}>{saving ? 'Saving…' : 'Save email'}</button>
    </form>}
    <div className="grid grid-cols-3 gap-2">
      <button type="button" className={buttonClass} disabled={!generationId || saving || subscribed}
        onClick={() => {
          if (!generationId) return;
          posthog.capture('generation_email_notification_clicked', { generation_id: generationId, source: isEdit ? 'landing_edit_actions' : 'landing_generation_actions', is_authenticated: Boolean(session) });
          if (session) void subscribe(); else setEmailOpen(open => !open);
        }}>{subscribed ? 'Email set' : saving ? 'Saving…' : 'Email me'}</button>
      {generationId ? <CancelGenerationButton generationId={generationId} onCancelled={onCancelled} isEdit={isEdit} compact />
        : <button type="button" className={buttonClass} disabled>Cancel</button>}
      <button type="button" className={buttonClass} disabled={!generationId} onClick={() => {
        posthog.capture(isEdit ? 'landing_edit_start_new_clicked' : 'landing_generation_start_new_clicked', { generation_id: generationId });
        onStartNew();
      }}>Start new</button>
    </div>
    {error && <p role="alert" className="mt-2 text-left text-xs text-red-600">{error}</p>}
  </div>;
}
