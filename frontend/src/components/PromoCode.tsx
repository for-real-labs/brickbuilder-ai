import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { useBilling } from '../contexts/BillingContext';
import { billingApi } from '../services/billingApi';

export function PromoCode({ source }: { source: string }) {
  const { user } = useAuth();
  const { refresh, signIn, closeUpgrade } = useBilling();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const owner = useRef(user?.id);
  owner.current = user?.id;
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  useEffect(() => { setCode(''); setError(''); setSuccess(false); }, [user?.id]);
  const close = () => { setOpen(false); posthog.capture('billing_promo_closed', { source }); };
  async function redeem(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !code.trim() || !user) return;
    const userId = user.id;
    setBusy(true); setError('');
    posthog.capture('billing_promo_submitted', { source });
    try {
      await billingApi.redeemPromo(code.trim());
      if (owner.current !== userId) return;
      await refresh();
      if (owner.current !== userId) return;
      setSuccess(true); setCode('');
      posthog.capture('billing_promo_redeemed', { source, type: 'builder' });
    } catch (failure) {
      if (owner.current !== userId) return;
      setError(failure instanceof Error ? failure.message : 'Could not redeem your promo. Try again.');
      posthog.capture('billing_promo_failed', { source });
    } finally { setBusy(false); }
  }
  return <div className="billing-promo">
    <button type="button" className="billing-text-link" onClick={() => { setOpen(true); posthog.capture('billing_promo_opened', { source }); }}>promo</button>
    {open && <dialog ref={dialog} className="billing-dialog billing-promo-dialog" aria-labelledby="billing-promo-title"
      onCancel={event => { event.preventDefault(); event.stopPropagation(); close(); }}>
      <button type="button" className="billing-close" aria-label="Close promo" onClick={close}><X size={20} /></button>
      <h2 id="billing-promo-title">Enter a promo code</h2>
      {success ? <p role="status">Promo redeemed! You now have free Builder access when you don’t have an active paid subscription.</p>
        : !user ? <><p>Sign in to apply a promo to your account.</p><button type="button" className="billing-plan-button" onClick={() => { posthog.capture('billing_promo_sign_in_clicked', { source }); close(); closeUpgrade(); signIn(); }}>Sign in</button></>
        : <form onSubmit={event => void redeem(event)}>
          <label htmlFor="billing-promo-code">Promo code</label>
          <input id="billing-promo-code" value={code} onChange={event => setCode(event.target.value)} maxLength={100} required autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={busy} />
          {error && <p role="alert" className="billing-error">{error}</p>}
          <button type="submit" className="billing-plan-button billing-plan-button--primary" disabled={busy || !code.trim()}>{busy ? 'Applying…' : 'Apply promo'}</button>
        </form>}
    </dialog>}
  </div>;
}
