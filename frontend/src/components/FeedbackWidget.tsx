import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, MessageSquare, Send, X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { MAX_FEEDBACK_LENGTH, sendFeedback } from '../services/feedbackApi';

export function FeedbackWidget() {
  const { user, loading: authLoading } = useAuth();
  const { pathname } = useLocation();
  const hasPurchaseControls = pathname === '/order' || pathname === '/generated-model';
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!open || hasPurchaseControls) return;
    dialog.current?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open, hasPurchaseControls]);

  const close = () => dialog.current?.close();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || authLoading) return;
    if (!description.trim()) {
      setError('Please enter a description.');
      return;
    }
    submitting.current = true;
    setStatus('sending');
    setError(null);
    try {
      await sendFeedback(description, user?.email, pathname);
      posthog.capture('feedback_submitted', { page: pathname, is_authenticated: Boolean(user) });
      if (mounted.current) {
        setStatus('sent');
        setDescription('');
      }
    } catch (failure) {
      posthog.capture('feedback_failed', { page: pathname, is_authenticated: Boolean(user) });
      if (mounted.current) {
        setStatus('idle');
        setError(failure instanceof Error ? failure.message : 'Feedback could not be sent. Please try again.');
      }
    } finally {
      submitting.current = false;
    }
  };

  // Keep kit purchase controls clear of the floating feedback trigger.
  if (hasPurchaseControls) return null;

  return <>
    <button ref={button} type="button" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => {
        if (status === 'sent') setStatus('idle');
        setError(null);
        setOpen(true);
        posthog.capture('feedback_opened', { page: pathname, is_authenticated: Boolean(user) });
      }}
      className="fixed z-[70] flex min-h-12 items-center gap-2 rounded-full border-2 border-white bg-[#f44336] px-5 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-[#d9362b] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-red-500"
      style={{ right: 'max(1rem, env(safe-area-inset-right))', bottom: 'max(1rem, env(safe-area-inset-bottom))' }}>
      <MessageSquare className="h-5 w-5" aria-hidden="true" /> Feedback
    </button>

    <dialog ref={dialog} aria-labelledby="feedback-title" aria-describedby="feedback-intro"
      onClose={() => {
        setOpen(false);
        button.current?.focus();
        posthog.capture('feedback_closed', { page: pathname });
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border-0 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/50 backdrop:backdrop-blur-sm">
      <div className="p-5 sm:p-7">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h2 id="feedback-title" className="text-xl font-bold">Share your feedback</h2>
            <p id="feedback-intro" className="mt-1 text-sm text-slate-500">Found a bug or have an idea? We’d love to hear it.</p>
          </div>
          <button type="button" onClick={close} aria-label="Close feedback"
            className="-mr-2 -mt-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-red-500">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        {status === 'sent' ? <div role="status" className="py-5 text-center">
          <CheckCircle2 aria-hidden="true" className="mx-auto mb-3 h-10 w-10 text-emerald-600" />
          <h3 className="text-lg font-semibold">Thanks for your feedback!</h3>
          <p className="mt-2 text-sm text-slate-500">Your message has been sent.</p>
          <button type="button" onClick={close} className="mt-6 min-h-11 rounded-full bg-slate-900 px-8 py-2.5 font-medium text-white hover:bg-slate-700">Done</button>
        </div> : <form onSubmit={submit}>
          <label htmlFor="feedback-description" className="mb-2 block text-sm font-semibold">Description</label>
          <textarea id="feedback-description" autoFocus required maxLength={MAX_FEEDBACK_LENGTH} rows={5}
            value={description} onChange={event => setDescription(event.target.value)}
            disabled={status === 'sending'} aria-invalid={Boolean(error)} aria-describedby={error ? 'feedback-error' : undefined}
            placeholder="Tell us what happened or what you’d like to see…"
            className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 disabled:bg-slate-50" />
          <p className="mt-2 break-words text-xs text-slate-500">{authLoading ? 'Checking your account…' : `Sending as ${user?.email || 'anon user'}`}</p>
          {error && <p id="feedback-error" role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={status === 'sending' || authLoading || !description.trim()}
            className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#f44336] px-5 py-3 text-sm font-semibold text-white hover:bg-[#d9362b] disabled:cursor-not-allowed disabled:opacity-50">
            {status === 'sending' ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Send aria-hidden="true" className="h-4 w-4" />}
            {status === 'sending' ? 'Sending…' : 'Send feedback'}
          </button>
        </form>}
      </div>
    </dialog>
  </>;
}
