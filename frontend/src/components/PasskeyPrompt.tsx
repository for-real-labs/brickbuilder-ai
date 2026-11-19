import React, { useEffect, useId, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { supabase } from '../lib/supabase';
import { addAccountPasskey, deviceAuthOptions } from '../services/deviceAuth';

export function PasskeyPrompt({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const element = useRef<HTMLDialogElement>(null);
  const operation = useRef<AbortController | null>(null);
  const title = useId();
  const storageKey = `brickbuilder.passkey-prompt:${userId}`;

  useEffect(() => {
    if (!deviceAuthOptions().passkey) return;
    try { if (localStorage.getItem(storageKey)) return; } catch { /* The prompt still works. */ }
    let active = true;
    void supabase.auth.passkey.list().then(({ data, error }) => {
      if (active && data?.length === 0 && !error) {
        setOpen(true);
        posthog.capture('account_passkey_prompt_shown');
      }
    }).catch(() => { /* Settings still offers registration. */ });
    return () => { active = false; operation.current?.abort(); };
  }, [storageKey]);

  useEffect(() => {
    const dialog = element.current;
    if (!open || !dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, [open]);

  const finish = (result: 'added' | 'later') => {
    try { localStorage.setItem(storageKey, result); } catch { /* Storage is optional. */ }
    posthog.capture('account_passkey_prompt_completed', { result });
    setOpen(false);
  };

  const add = async () => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(false);
    posthog.capture('account_passkey_prompt_add_clicked');
    try {
      await addAccountPasskey(controller.signal);
      if (!controller.signal.aborted) finish('added');
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { operation.current = null; if (!controller.signal.aborted) setBusy(false); }
  };

  if (!open) return null;
  return <dialog ref={element} aria-labelledby={title}
    className="m-auto w-[min(26rem,calc(100%_-_2rem))] rounded-2xl bg-white p-5 shadow-xl backdrop:bg-slate-900/40 sm:p-6"
    onCancel={event => { event.preventDefault(); if (!busy) finish('later'); }}>
    <h2 id={title} className="text-lg font-semibold text-slate-900">Add a passkey?</h2>
    <p className="mt-2 text-sm text-slate-600">Sign in next time with Face ID, Touch ID, or your device’s screen lock. You can also set this up in Settings.</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">Could not add a passkey. Please try again.</p>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      <button type="button" className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm" disabled={busy} onClick={() => finish('later')}>Not now</button>
      <button type="button" className="min-h-11 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white" disabled={busy} onClick={() => void add()}>
        {busy ? 'Adding…' : 'Add a passkey'}
      </button>
    </div>
  </dialog>;
}
