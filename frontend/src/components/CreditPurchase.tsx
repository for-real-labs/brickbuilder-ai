import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import posthog from 'posthog-js';
import { useBilling } from '../contexts/BillingContext';
import { isAppleApp } from '../services/applePurchases';
import { creditPurchaseCents, purchasedCredits } from '../utils/creditPurchase';

export function CreditPacks({ source }: { source: string }) {
  const { account, loading, busy, enabled, checkoutAvailable, buyCredits, appleProducts, openUpgrade } = useBilling();
  const [amount, setAmount] = useState('5.00');
  const [applePack, setApplePack] = useState('builder');
  const [notice, setNotice] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const apple = isAppleApp();
  const cents = creditPurchaseCents(amount);
  const credits = cents === null ? null : purchasedCredits(cents, account?.plan_key);
  const paid = Boolean(account?.has_subscription && account.paid_features && account.plan_key !== 'free');
  const appleCredits = applePack === 'builder' ? 800 : 1500;
  const appleProduct = appleProducts.find(product => product.id === `ai.brickbuilder.app.credits.${appleCredits}`);
  useEffect(() => {
    if (!notice) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = dialog.current;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { if (element?.open) element.close(); document.body.style.overflow = overflow; trigger?.focus(); };
  }, [notice]);
  const closeNotice = (reason: string) => {
    posthog.capture('billing_credit_subscription_notice_closed', { source, reason });
    setNotice(false);
  };
  return <section id="credit-packs" className="billing-credit-purchase" aria-labelledby={`${id}-title`}>
    <div><h2 id={`${id}-title`}>Buy credits</h2><p>One-time credits never expire.</p></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (!paid) {
        posthog.capture('billing_credit_subscription_required', { source });
        setNotice(true);
        return;
      }
      if (apple && appleProduct) void buyCredits(applePack, source);
      else if (!apple && cents !== null) void buyCredits(cents, source);
    }}>
      {apple ? <label htmlFor={`${id}-amount`}>Credits
        <select id={`${id}-amount`} value={applePack} onChange={event => {
          setApplePack(event.target.value);
          posthog.capture('billing_credit_amount_changed', { source, provider: 'apple', pack_key: event.target.value });
        }}>
          {['builder', 'creator'].map(key => {
            const count = key === 'builder' ? 800 : 1500;
            const product = appleProducts.find(item => item.id === `ai.brickbuilder.app.credits.${count}`);
            return <option key={key} value={key}>{count.toLocaleString()} · {product?.displayPrice ?? 'Unavailable'}</option>;
          })}
        </select>
      </label> : <label htmlFor={`${id}-amount`}>Amount (USD)
        <input id={`${id}-amount`} type="number" inputMode="decimal" min="0.50" max="9999.99" step="0.01" required value={amount}
          aria-describedby={`${id}-quote`} onChange={event => setAmount(event.target.value)}
          onBlur={() => posthog.capture('billing_credit_amount_changed', { source, amount_cents: cents })} />
      </label>}
      <output id={`${id}-quote`} htmlFor={`${id}-amount`} aria-live="polite">{apple ? 'Apple sets available amounts.' : credits === null ? 'Enter $0.50–$9,999.99' : `${credits.toLocaleString()} credits`}</output>
      <button type="submit" className="billing-secondary" disabled={busy || loading || !enabled || !checkoutAvailable || (paid && apple && !appleProduct)}>{busy ? 'Opening…' : 'Buy credits'}</button>
    </form>
    {notice && <dialog ref={dialog} className="billing-dialog billing-feature-dialog" aria-labelledby={`${id}-notice-title`}
      aria-describedby={`${id}-notice-description`} onCancel={event => { event.preventDefault(); closeNotice('cancel'); }}>
      <button type="button" className="billing-close" aria-label="Close subscription notice" onClick={() => closeNotice('close_button')}><X size={20} /></button>
      <h2 id={`${id}-notice-title`}>Paid monthly plan required</h2>
      <p id={`${id}-notice-description`}>You must be subscribed to a paid monthly plan to buy credits.</p>
      <div className="billing-feature-actions">
        <button type="button" className="billing-primary" onClick={() => {
          posthog.capture('billing_credit_subscription_upgrade_clicked', { source });
          setNotice(false); openUpgrade('credit_purchase_subscription');
        }}>View plans</button>
        <button type="button" className="billing-secondary" onClick={() => closeNotice('close_button')}>Close</button>
      </div>
    </dialog>}
  </section>;
}
