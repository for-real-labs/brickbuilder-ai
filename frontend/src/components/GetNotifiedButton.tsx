import React from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, Loader2, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GenerationEmailApi } from '../services/generationEmailApi';

export function GetNotifiedButton({ generationId }: { generationId: string }) {
  const { session } = useAuth();
  const [subscribed, setSubscribed] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const button = React.useRef<HTMLButtonElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const controller = new AbortController();
    void GenerationEmailApi.status(generationId, controller.signal).then(result => {
      if (!controller.signal.aborted) setSubscribed(result.subscribed);
    }).catch(() => {});
    return () => controller.abort();
  }, [generationId, session?.user.id]);
  React.useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; button.current?.focus(); };
  }, [open]);
  const save = async () => {
    if (busy || subscribed) return;
    setBusy(true); setError('');
    try {
      await GenerationEmailApi.subscribe(generationId, session ? undefined : email.trim());
      setSubscribed(true); setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Please try again.');
    } finally { setBusy(false); }
  };
  return <div className="relative z-20 mt-2">
    <button ref={button} type="button" disabled={busy} aria-disabled={subscribed || undefined}
      onClick={() => { if (subscribed) return; setError(''); if (session) void save(); else setOpen(true); }}
      className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-default disabled:opacity-70 aria-disabled:cursor-default aria-disabled:opacity-70">
      {busy ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : subscribed ? <Check aria-hidden className="h-4 w-4" /> : <Bell aria-hidden className="h-4 w-4" />}
      {subscribed ? 'We’ll email you' : 'Get notified'}
    </button>
    {!open && error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
    {open && createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4" onClick={event => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) setOpen(false);
          if (event.key === 'Tab') {
            const controls = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)'));
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <button type="button" aria-label="Close email notification" disabled={busy} onClick={() => setOpen(false)} className="absolute right-4 top-4 rounded-full p-2 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        <h2 id={titleId} className="pr-9 text-xl font-semibold text-slate-900">Get notified</h2>
        <p className="mt-2 text-sm text-slate-600">We’ll send one email when your model is ready. No newsletter.</p>
        <form onSubmit={event => { event.preventDefault(); void save(); }} className="mt-5">
          <label htmlFor={`${titleId}-email`} className="text-sm font-medium text-slate-700">Email address</label>
          <input ref={input} id={`${titleId}-email`} type="email" autoComplete="email" required maxLength={254} disabled={busy} value={email} onChange={event => setEmail(event.target.value)} className="mt-2 h-12 w-full rounded-xl border border-slate-300 px-3 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100" />
          {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[#f44336] px-5 font-semibold text-white hover:bg-[#ff6b6b] disabled:opacity-60">{busy && <Loader2 aria-hidden className="h-4 w-4 animate-spin" />}Notify me</button>
        </form>
      </div>
    </div>, document.body)}
  </div>;
}
