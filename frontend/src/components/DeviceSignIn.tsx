import React, { useEffect, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import posthog from 'posthog-js';
import { deviceAuthOptions, signInWithApple, signInWithPasskey } from '../services/deviceAuth';

type Method = 'apple' | 'passkey';

export function DeviceSignIn({ surface, busy = false, onBusyChange, onSuccess }: {
  surface: 'login_modal' | 'login_page' | 'signup_page' | 'plan_checkout';
  busy?: boolean;
  onBusyChange: (busy: boolean) => void;
  onSuccess: () => void;
}) {
  const { apple, passkey } = deviceAuthOptions();
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  if (!apple && !passkey) return null;

  const signIn = async (method: Method) => {
    if (busy || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setError('');
    onBusyChange(true);
    posthog.capture('auth_method_selected', { surface, method });
    try {
      const authenticate = method === 'apple' ? signInWithApple : signInWithPasskey;
      const signedIn = await authenticate(controller.signal);
      if (signedIn && !controller.signal.aborted) onSuccess();
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not sign in. Please try again.');
    } finally {
      active.current = null;
      onBusyChange(false);
    }
  };

  return <div className="mt-4 grid gap-3">
    {apple && <button type="button" className="mx-auto flex h-11 w-full max-w-[270px] items-center justify-center overflow-hidden rounded-lg bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
      disabled={busy} onClick={() => void signIn('apple')}>
      <img src="/auth/sign-in-with-apple.png" alt="Sign in with Apple" className="max-h-full max-w-full object-contain" width="270" height="44" />
    </button>}
    {passkey && <button type="button" className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
      disabled={busy} onClick={() => void signIn('passkey')}>
      <KeyRound size={18} aria-hidden="true" /> Sign in with a passkey
    </button>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
  </div>;
}
