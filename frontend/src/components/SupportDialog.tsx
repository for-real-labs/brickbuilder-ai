import React, { useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Send, X } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { MAX_SUPPORT_MESSAGE, SUPPORT_EMAIL, sendSupport } from '../services/supportApi';

export function SupportDialog({ open, onClose, generationId, returnFocusRef }: {
  open: boolean;
  onClose: () => void;
  generationId?: string;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { user, loading: authLoading } = useAuth();
  const [email, setEmail] = useState(user?.email || '');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const emailEdited = useRef(false);
  const attempt = useRef<{ draft: string; id: string } | null>(null);
  const id = useId();
  const track = (event: string) => posthog.capture(event, { is_authenticated: Boolean(user), has_generation: Boolean(generationId) });

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!emailEdited.current) setEmail(user?.email || ''); }, [user?.email]);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    track('support_opened');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  const close = () => dialog.current?.close();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current || authLoading) return;
    const draft = JSON.stringify([email.trim(), message.trim(), generationId, user?.id]);
    if (attempt.current?.draft !== draft) attempt.current = { draft, id: crypto.randomUUID() };
    submitting.current = true;
    setStatus('sending');
    setError(null);
    track('support_send_clicked');
    try {
      await sendSupport({ email, message, generationId, requestId: attempt.current.id });
      track('support_sent');
      if (mounted.current) { setStatus('sent'); setMessage(''); attempt.current = null; }
    } catch (failure) {
      track('support_failed');
      if (mounted.current) {
        setStatus('idle');
        setError(failure instanceof Error ? failure.message : 'Could not send. Please retry.');
      }
    } finally { submitting.current = false; }
  };

  if (!open) return null;
  const fieldClass = 'w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-base text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 disabled:bg-slate-50';
  return <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
    onClose={() => {
      onClose();
      if (status === 'sent') setStatus('idle');
      returnFocusRef.current?.focus();
      track('support_closed');
    }}
    className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-2xl border-0 bg-white p-5 text-left text-slate-900 shadow-2xl backdrop:bg-slate-950/50 backdrop:backdrop-blur-sm sm:p-7">
    <div className="flex items-center justify-between gap-4">
      <h2 id={`${id}-title`} className="text-xl font-bold">Support</h2>
      <button type="button" onClick={close} aria-label="Close support" className="-mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-red-500">
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
    <p id={`${id}-intro`} className="mb-5 text-sm leading-6 text-slate-500">Send here or email <a href={`mailto:${SUPPORT_EMAIL}`} onClick={() => track('support_direct_email_clicked')} className="break-all font-medium text-red-600 underline underline-offset-2">{SUPPORT_EMAIL}</a>.</p>
    {status === 'sent' ? <div role="status" className="py-4 text-center">
      <CheckCircle2 className="mx-auto mb-3 h-9 w-9 text-emerald-600" aria-hidden="true" />
      <p className="font-semibold">Message sent.</p>
      <button type="button" onClick={close} className="mt-5 min-h-11 rounded-full bg-slate-900 px-8 py-2 text-sm font-medium text-white hover:bg-slate-700">Done</button>
    </div> : <form onSubmit={submit} aria-busy={status === 'sending'}>
      <label htmlFor={`${id}-email`} className="mb-2 block text-sm font-semibold">Your email</label>
      <input id={`${id}-email`} type="email" autoComplete="email" required maxLength={254} value={email} disabled={status === 'sending'}
        onChange={event => { emailEdited.current = true; setEmail(event.target.value); }} className={fieldClass} />
      <label htmlFor={`${id}-message`} className="mt-4 mb-2 block text-sm font-semibold">Message</label>
      <textarea id={`${id}-message`} rows={4} required maxLength={MAX_SUPPORT_MESSAGE} value={message} disabled={status === 'sending'}
        onChange={event => setMessage(event.target.value)} className={`${fieldClass} resize-y`} />
      <p className="mt-2 text-xs text-slate-500">Includes your user ID and model details, when available.</p>
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={status === 'sending' || authLoading || !email.trim() || !message.trim()}
        className="mt-5 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#f44336] px-5 py-3 text-sm font-semibold text-white hover:bg-[#d9362b] disabled:cursor-not-allowed disabled:opacity-50">
        {status === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
        {status === 'sending' ? 'Sending…' : 'Send'}
      </button>
    </form>}
  </dialog>;
}
