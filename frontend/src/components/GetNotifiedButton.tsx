import React, { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { GenerationEmailApi } from '../services/generationEmailApi';
import { PetChatMessage } from './PetCompanion';

export function GetNotifiedButton({ generationId, promptOnStart = false, onPromptShown }: {
  generationId: string; promptOnStart?: boolean; onPromptShown?: () => void;
}) {
  const { session } = useAuth();
  return <BuddyNotification key={`${generationId}:${session?.user.id || 'guest'}`} generationId={generationId}
    accountEmail={session?.user.email} signedIn={!!session} promptOnStart={promptOnStart} onPromptShown={onPromptShown} />;
}

function BuddyNotification({ generationId, accountEmail, signedIn, promptOnStart, onPromptShown }: {
  generationId: string; accountEmail?: string; signedIn: boolean;
  promptOnStart: boolean; onPromptShown?: () => void;
}) {
  const [stage, setStage] = useState<'prompt' | 'email' | 'success' | 'declined' | null>(promptOnStart ? 'prompt' : null);
  const [email, setEmail] = useState(accountEmail || '');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answeredYes, setAnsweredYes] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const promptShown = useRef(false);
  const emailId = React.useId();
  const properties = { generation_id: generationId, is_authenticated: signedIn, source: 'build_buddy_chat' };

  useEffect(() => {
    if (!promptOnStart || promptShown.current) return;
    promptShown.current = true;
    setStage(current => current === 'success' ? current : 'prompt');
    posthog.capture('generation_email_notification_prompt_shown', { generation_id: generationId, is_authenticated: signedIn, source: 'build_buddy_chat' });
    onPromptShown?.();
  }, [promptOnStart, generationId, signedIn, onPromptShown]);
  useEffect(() => {
    const controller = new AbortController();
    statusRequest.current = controller;
    void GenerationEmailApi.status(generationId, controller.signal).then(result => {
      if (!controller.signal.aborted && result.subscribed) {
        setRecipient(result.email); setStage('success');
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [generationId]);
  useEffect(() => { if (stage === 'email') input.current?.focus(); }, [stage]);

  const save = async () => {
    if (busy || stage === 'success') return;
    if (!signedIn && !input.current?.reportValidity()) return;
    statusRequest.current?.abort();
    setBusy(true); setError('');
    posthog.capture('generation_email_notification_requested', properties);
    try {
      const result = await GenerationEmailApi.subscribe(generationId, signedIn ? undefined : email.trim());
      if (!result.subscribed) throw new Error('I couldn’t save that notification. Please try again.');
      setRecipient(result.email); setStage('success');
      posthog.capture('generation_email_notification_subscribed', properties);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Please try again.');
    } finally { setBusy(false); }
  };
  const buttonClass = 'pet-chat-action';
  if (!stage) return <button type="button" className={buttonClass} onClick={() => {
    setStage('prompt'); posthog.capture('generation_email_notification_clicked', properties);
  }}>Get notified</button>;

  return <div className="pet-notification-conversation">
    <PetChatMessage>
      <p>This might take a while, sometimes up to 30 minutes. Would you like an email when your build is ready?</p>
      {stage === 'prompt' && <div className="pet-chat-actions">
        <button type="button" disabled={busy} className={buttonClass} onClick={() => {
          setAnsweredYes(true);
          posthog.capture('build_buddy_notification_answered', { ...properties, answer: 'yes' });
          if (signedIn) void save(); else setStage('email');
        }}>{busy ? 'Saving…' : 'Yes, email me'}</button>
        <button type="button" disabled={busy} className={buttonClass} onClick={() => {
          statusRequest.current?.abort(); setStage('declined');
          posthog.capture('generation_email_notification_dismissed', { ...properties, stage: 'prompt' });
        }}>Not now</button>
      </div>}
    </PetChatMessage>
    {answeredYes && stage !== 'declined' && <PetChatMessage user><p>Yes, email me.</p></PetChatMessage>}
    {stage === 'email' && <>
      <PetChatMessage>
        <p>What email should I use? I’ll send one message when it’s ready.</p>
        <label htmlFor={emailId} className="sr-only">Email address</label>
        <div className="pet-chat-email">
          <input ref={input} id={emailId} type="email" autoComplete="email" placeholder="you@example.com" required
            maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void save(); } }} />
          <button type="button" className={buttonClass} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Notify me'}</button>
        </div>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => {
          setStage('declined'); posthog.capture('generation_email_notification_dismissed', { ...properties, stage: 'email' });
        }}>Not now</button>
      </PetChatMessage>
    </>}
    {stage === 'success' && <PetChatMessage><p role="status">You’re all set! {recipient
      ? <>I’ll email <strong>{recipient}</strong> when your build is ready.</>
      : 'Your email notification is saved.'}</p></PetChatMessage>}
    {stage === 'declined' && <>
      <PetChatMessage user><p>Not now.</p></PetChatMessage>
      <PetChatMessage><p>Okay! Your build will keep running. You can check it here anytime.</p>
        <button type="button" className={buttonClass} onClick={() => {
          setAnsweredYes(false); setError(''); setStage('prompt'); posthog.capture('generation_email_notification_clicked', properties);
        }}>Get notified</button>
      </PetChatMessage>
    </>}
    {error && <PetChatMessage><p role="alert">{error}</p></PetChatMessage>}
  </div>;
}
