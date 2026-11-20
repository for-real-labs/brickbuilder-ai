import React, { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { addAccountPasskey, deviceAuthOptions } from '../services/deviceAuth';

export function PasskeySettings() {
  const { user } = useAuth();
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  if (!deviceAuthOptions().passkey || !user || user.is_anonymous) return null;

  const addPasskey = async () => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setStatus('saving');
    posthog.capture('account_add_passkey_clicked');
    try {
      await addAccountPasskey(controller.signal);
      if (!controller.signal.aborted) setStatus('saved');
    } catch {
      if (!controller.signal.aborted) setStatus('error');
    } finally {
      active.current = null;
    }
  };

  return <section className="mb-3 max-w-2xl rounded-xl border border-slate-200 bg-white p-5 sm:mb-4 sm:p-6">
    <h2 className="text-lg font-semibold text-slate-900">Passkeys</h2>
    <p className="mt-1 text-sm text-slate-600">Sign in with Face ID, Touch ID, or a security key.</p>
    <button type="button" className="mt-3 min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
      disabled={status === 'saving'} onClick={() => void addPasskey()}>{status === 'saving' ? 'Adding…' : 'Add a passkey'}</button>
    {status === 'saved' && <p role="status" className="mt-2 text-sm text-green-700">Passkey added.</p>}
    {status === 'error' && <p role="alert" className="mt-2 text-sm text-red-700">Could not add a passkey. Please try again.</p>}
  </section>;
}
