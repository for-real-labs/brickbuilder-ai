import React, { useEffect, useState } from 'react';
import { ArrowRight, BellRing, X } from 'lucide-react';
import posthog from 'posthog-js';
import type { ModelNotification } from '../services/generationNotificationsApi';

export function GenerationNotificationSnackbar({ notification, onOpen, onDismiss }: {
  notification: ModelNotification;
  onOpen: (id: string) => Promise<void>;
  onDismiss: (id: string) => void;
}) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    posthog.capture('generation_notification_snackbar_shown', { generation_id: notification.id });
  }, [notification.id]);
  useEffect(() => {
    if (paused || opening || error) return;
    const timer = setTimeout(() => onDismiss(notification.id), 10000);
    return () => clearTimeout(timer);
  }, [notification.id, onDismiss, paused, opening, error]);

  return <div role="status" aria-live="polite" aria-atomic="true"
    onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setPaused(false);
    }}
    className="fixed bottom-4 left-4 right-4 z-[80] rounded-2xl border border-slate-700 bg-slate-900 text-white shadow-xl sm:left-auto sm:w-96">
    <div className="flex items-start gap-1 p-2">
      <button type="button" disabled={opening} onClick={async () => {
        setOpening(true); setError(null);
        posthog.capture('generation_notification_snackbar_clicked', { generation_id: notification.id });
        try { await onOpen(notification.id); }
        catch { setError('Unable to open this notification. Please try again.'); }
        finally { setOpening(false); }
      }} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400 disabled:opacity-70">
        <BellRing className="h-5 w-5 shrink-0 text-red-300" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{notification.is_edit ? 'Your edit is ready' : 'Your model is ready'}</span>
          <span className="mt-1 block truncate text-xs text-slate-300">{notification.prompt}</span>
          <span className="mt-2 flex items-center gap-1 text-xs font-medium text-red-300">{opening ? 'Opening…' : 'View model'} <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>
        </span>
      </button>
      <button type="button" aria-label="Dismiss notification" onClick={() => {
        posthog.capture('generation_notification_snackbar_dismissed', { generation_id: notification.id });
        onDismiss(notification.id);
      }} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    {error && <p role="alert" className="px-5 pb-4 text-xs text-red-200">{error}</p>}
  </div>;
}
