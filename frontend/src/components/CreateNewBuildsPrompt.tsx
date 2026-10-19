import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Box, Loader2 } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import type { GenerationActivity } from '../hooks/useGenerationActivity';
import { GenerationEmailApi } from '../services/generationEmailApi';
import type { GenerationWithOrder } from '../services/getUserGenerationsApi';
import { getGeneratedModelPath } from '../utils/generationRoutes';
import { CancelGenerationButton } from './CancelGenerationButton';
import { GenerationElapsedTime } from './GenerationElapsedTime';
import { PetChatMessage } from './PetCompanion';

function ProcessingBuildRow({ row, onCancelled }: { row: GenerationActivity; onCancelled: (id: string) => void }) {
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [recipient, setRecipient] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void GenerationEmailApi.status(row.id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setSubscribed(result.subscribed);
      setRecipient(result.email);
    }).catch(() => {}).finally(() => { if (!controller.signal.aborted) setStatusChecked(true); });
    return () => controller.abort();
  }, [row.id]);

  const subscribe = async () => {
    if (saving || subscribed) return;
    setSaving(true);
    setError(null);
    const properties = { generation_id: row.id, source: 'landing_builds_dialogue', is_authenticated: Boolean(session) };
    posthog.capture('generation_email_notification_requested', properties);
    try {
      const result = await GenerationEmailApi.subscribe(row.id, session ? undefined : email.trim());
      if (!result.subscribed) throw new Error('Could not save your email. Please try again.');
      setSubscribed(true);
      setStatusChecked(true);
      setRecipient(result.email);
      setEmailOpen(false);
      posthog.capture('generation_email_notification_subscribed', properties);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your email. Please try again.');
    } finally { setSaving(false); }
  };

  return <li className="pet-build-list-row pet-processing-build-row">
    <div className="pet-processing-build-heading"><Loader2 size={18} className="animate-spin" aria-hidden="true" />
      <span>{row.name || row.prompt || 'Your build'}<small>Processing</small></span></div>
    <GenerationElapsedTime startedAt={row.createdAt} />
    {subscribed ? <p className="pet-processing-build-email" role="status">{recipient
      ? `Email will be sent to ${recipient} when ready.` : 'Email will be sent when ready.'}</p> : <>
      {emailOpen && <form className="pet-chat-email" onSubmit={event => { event.preventDefault(); void subscribe(); }}>
        <label className="sr-only" htmlFor={`build-email-${row.id}`}>Email address</label>
        <input id={`build-email-${row.id}`} type="email" autoComplete="email" required maxLength={254}
          value={email} onChange={event => setEmail(event.target.value)} disabled={saving} placeholder="you@example.com" />
        <button type="submit" className="pet-chat-action" disabled={saving}>{saving ? 'Saving…' : 'Save email'}</button>
      </form>}
      {error && <p role="alert" className="pet-processing-build-error">{error}</p>}
    </>}
    <div className="pet-chat-actions pet-processing-build-actions">
      {!subscribed && statusChecked && <button type="button" className="pet-chat-action" disabled={saving} onClick={() => {
        posthog.capture('generation_email_notification_clicked', { generation_id: row.id, source: 'landing_builds_dialogue', is_authenticated: Boolean(session) });
        if (session) void subscribe(); else setEmailOpen(true);
      }}>Email when ready</button>}
      <CancelGenerationButton generationId={row.id} onCancelled={() => onCancelled(row.id)} compact />
    </div>
  </li>;
}

export function CreateNewBuildsPrompt({ processing, completed, page, pageSize, onBack, onView, onMore, onCancelled }: {
  processing: GenerationActivity[];
  completed: GenerationWithOrder[];
  page: number;
  pageSize: number;
  onBack: () => void;
  onView: (id: string) => void;
  onMore: () => void;
  onCancelled: (id: string) => void;
}) {
  const completedCount = completed.length;
  return <PetChatMessage>
    <p>{processing.length || completedCount ? 'Here are your builds.' : 'You don’t have any builds yet.'}</p>
    {(processing.length > 0 || completedCount > 0) && <>
      <ul className="pet-completed-builds pet-current-builds" aria-label="Your current builds">
        {processing.map(row => <ProcessingBuildRow key={row.id} row={row} onCancelled={onCancelled} />)}
        {completed.slice(page * pageSize, (page + 1) * pageSize).map(row => <li key={row.id}>
          <a href={getGeneratedModelPath(row.id, true)} onClick={event => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            posthog.capture('landing_create_new_build_viewed', { generation_id: row.id });
            onView(row.id);
          }}>
            <span className="pet-completed-build-preview">{row.preview_image_url || row.processed_image_url || row.external_image_url
              ? <img src={row.preview_image_url || row.processed_image_url || row.external_image_url} alt="" loading="lazy" /> : <Box size={32} aria-hidden="true" />}</span>
            <span className="pet-completed-build-title">{row.name || row.prompt || 'Your build'}<span>View model <ArrowUpRight size={14} aria-hidden="true" /></span></span>
          </a>
        </li>)}
      </ul>
      {(page + 1) * pageSize < completedCount && <div className="pet-chat-actions pet-more-builds">
        <span>Want to view more?</span>
        <button type="button" className="pet-chat-action" onClick={() => {
          posthog.capture('landing_recent_builds_more_clicked', { page: page + 1, completed_count: completedCount });
          onMore();
        }}>Yes, show more</button>
      </div>}
    </>}
    <button type="button" className="pet-chat-action" onClick={onBack}>Go back</button>
  </PetChatMessage>;
}
