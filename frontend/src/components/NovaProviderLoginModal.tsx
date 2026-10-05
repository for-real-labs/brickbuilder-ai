import React, { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { ProviderConnection } from './LocalProviderSettings';
import { LocalProvidersApiService, type LocalProviderStatus } from '../services/localProvidersApi';

export type NovaLoginProvider = 'openai' | 'anthropic';

export function NovaProviderLoginModal({ provider, onClose, onConnected }: {
  provider: NovaLoginProvider | null;
  onClose: () => void;
  onConnected: (mode: 'native' | 'api_key') => void;
}) {
  const [status, setStatus] = useState<LocalProviderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onClose, onConnected });
  const activeProvider = useRef(provider);
  activeProvider.current = provider;
  callbacks.current = { onClose, onConnected };

  useEffect(() => {
    if (!provider) return;
    const controller = new AbortController();
    setStatus(null); setError(''); setBusy(false);
    void LocalProvidersApiService.getProviderStatus(provider, controller.signal)
      .then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not check your connection. Make sure the local Nova runtime is running.'); });
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') callbacks.current.onClose();
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') || []);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { controller.abort(); window.removeEventListener('keydown', onKey); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [provider]);

  const pending = status && ['starting', 'pending'].includes(status.login.status);
  useEffect(() => {
    if (!provider || !pending) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void LocalProvidersApiService.getProviderStatus(provider, controller.signal).then(value => {
        if (controller.signal.aborted) return;
        setStatus(value); setError('');
        if (value.cli_connected) callbacks.current.onConnected('native');
      }).catch(() => { if (!controller.signal.aborted) setError('Waiting to reconnect to Nova…'); });
    }, 2000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [provider, pending]);

  if (!provider) return null;
  const label = provider === 'openai' ? 'ChatGPT' : 'Claude';
  return <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="nova-login-title" tabIndex={-1}
      className="ph-no-capture relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 text-left shadow-xl focus:outline-none">
      <button type="button" aria-label="Close provider login" onClick={onClose} className="absolute right-3 top-3 rounded-full p-2 text-slate-500 hover:bg-slate-100"><X size={20} /></button>
      <h2 id="nova-login-title" className="pr-8 text-xl font-medium text-slate-900">Connect {label}</h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">Sign in with {label} to use your account for All parts models. Continue on {label}’s website to finish.</p>
      {!status && !error && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" /> Checking connection…</p>}
      {error && <p role="alert" className="mt-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">{error}</p>}
      {status && <div className="mt-4"><ProviderConnection provider={status} disabled={busy} busy={busy}
        onSelectConnection={onConnected}
        onAction={async action => {
          setBusy(true); setError('');
          try {
            const value = await action();
            if (activeProvider.current !== provider) return;
            setStatus(value);
            if (value.cli_connected) callbacks.current.onConnected('native');
          } catch { if (activeProvider.current === provider) setError('Could not connect your account. Please try again.'); }
          finally { if (activeProvider.current === provider) setBusy(false); }
        }} /></div>}
      <p className="mt-4 text-xs leading-5 text-slate-500">Nova keeps your connection in private storage on this computer. Your password stays with {label}.</p>
    </div>
  </div>;
}
