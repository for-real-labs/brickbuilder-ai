import React from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, Loader2, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GenerationEmailApi } from '../services/generationEmailApi';
import posthog from 'posthog-js';

export function GetNotifiedButton({ generationId }: { generationId: string }) {
  const { session } = useAuth();
  return <NotificationButton key={`${generationId}:${session?.user.id || 'guest'}`}
    generationId={generationId} signedIn={!!session} />;
}

function NotificationButton({ generationId, signedIn }: { generationId: string; signedIn: boolean }) {
  const [subscribed, setSubscribed] = React.useState(false);
  const [stage, setStage] = React.useState<'email' | 'success' | null>(null);
  const [email, setEmail] = React.useState('');
  const [recipient, setRecipient] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const button = React.useRef<HTMLButtonElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const statusRequest = React.useRef<AbortController | null>(null);
  const titleId = React.useId();
  const descriptionId = `${titleId}-description`;
  React.useEffect(() => {
    const controller = new AbortController();
    statusRequest.current = controller;
    void GenerationEmailApi.status(generationId, controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setSubscribed(result.subscribed);
        setRecipient(result.email);
      }
    }).catch(() => {});
    return () => controller.abort();
  }, [generationId]);
  React.useEffect(() => {
    if (!stage) return;
    (input.current || dialog.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [stage]);
  const open = stage !== null;
  React.useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; button.current?.focus(); };
  }, [open]);
  const save = async () => {
    if (busy || subscribed) return;
    statusRequest.current?.abort();
    setBusy(true); setError('');
    posthog.capture('generation_email_notification_requested', { generation_id: generationId, is_authenticated: signedIn });
    try {
      const result = await GenerationEmailApi.subscribe(generationId, signedIn ? undefined : email.trim());
      setRecipient(result.email);
      setSubscribed(true); setStage('success');
      posthog.capture('generation_email_notification_subscribed', { generation_id: generationId, is_authenticated: signedIn });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Please try again.');
    } finally { setBusy(false); }
  };
  const close = () => {
    setStage(null);
    posthog.capture('generation_email_notification_dismissed', { generation_id: generationId, stage });
  };
  return <div className="relative z-20 mt-2">
    <button ref={button} type="button" disabled={busy} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => {
        posthog.capture('generation_email_notification_clicked', { generation_id: generationId, is_authenticated: signedIn, subscribed });
        setError('');
        if (subscribed) setStage('success');
        else if (signedIn) void save();
        else setStage('email');
      }}
      className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-70">
      {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : subscribed ? <Check aria-hidden className="h-4 w-4" /> : <Bell aria-hidden className="h-4 w-4" />}
      {subscribed ? 'We’ll email you' : 'Get notified'}
    </button>
    {subscribed && recipient && <p className="mt-2 break-all text-xs text-slate-600">
      Emailing <strong className="font-semibold text-slate-900">{recipient}</strong>
    </p>}
    {!open && error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    {open && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) close();
          if (event.key === 'Tab') {
            const controls = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <button type="button" aria-label="Close email notification" disabled={busy} onClick={close} className="absolute right-4 top-4 rounded-full p-2 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        {stage === 'success' ? <>
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-green-600"><Check aria-hidden className="h-6 w-6" /></div>
          <h2 id={titleId} className="pr-9 text-xl font-semibold text-slate-900">You’re all set</h2>
          <p id={descriptionId} className="mt-2 text-sm text-slate-600">{recipient
            ? <>We’ll send one email to <strong className="break-all font-semibold text-slate-900">{recipient}</strong> when your model is ready. No newsletter.</>
            : 'Your email notification is saved. Refresh to see the recipient email address.'}</p>
          <button type="button" onClick={close} className="mt-5 h-12 w-full rounded-full bg-[#f44336] px-5 font-semibold text-white hover:bg-[#ff6b6b]">Done</button>
        </> : <>
        <h2 id={titleId} className="pr-9 text-xl font-semibold text-slate-900">Get notified</h2>
        <p id={descriptionId} className="mt-2 text-sm text-slate-600">We’ll send one email when your model is ready. No newsletter.</p>
        <form onSubmit={event => { event.preventDefault(); void save(); }} className="mt-5">
          <label htmlFor={`${titleId}-email`} className="text-sm font-medium text-slate-700">Email address</label>
          <input ref={input} id={`${titleId}-email`} type="email" autoComplete="email" required maxLength={254} disabled={busy} value={email} onChange={event => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-slate-300 px-3 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100" />
          {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#f44336] px-5 font-semibold text-white hover:bg-[#ff6b6b] disabled:opacity-60">{busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}Notify me</button>
        </form>
        </>}
      </div>
    </div>, document.body)}
  </div>;
}
