import React, { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import posthog from 'posthog-js';
import { useBilling } from '../contexts/BillingContext';
import { isAppleApp } from '../services/applePurchases';
import { CREDIT_PACKS, appleCreditProduct, creditPackSavings, type AppleCreditPackKey } from '../utils/creditPurchase';
import { formatOrderPrice } from '../utils/orderCheckout';

const LEGACY_APPLE_PACKS = [{ key: '800', credits: 800 }, { key: '1500', credits: 1500 }] as const;

export function CreditPacks({ source }: { source: string }) {
  const { account, loading, busy, enabled, checkoutAvailable, buyCredits, appleProducts, openUpgrade } = useBilling();
  const [packKey, setPackKey] = useState<AppleCreditPackKey>(CREDIT_PACKS[0].key);
  const [notice, setNotice] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const apple = isAppleApp();
  const paid = Boolean(account?.has_subscription && account.paid_features && account.plan_key !== 'free');
  const appleOptions = (packs: readonly { key: AppleCreditPackKey; credits: number }[]) => packs.flatMap(pack => {
    const product = appleProducts.find(item => item.id === appleCreditProduct(pack.key));
    return product?.displayPrice ? [{ ...pack, displayPrice: product.displayPrice, price: product.price ?? 0 }] : [];
  });
  const newAppleOptions = apple ? appleOptions(CREDIT_PACKS) : [];
  const options = apple
    ? newAppleOptions.length ? newAppleOptions : appleOptions(LEGACY_APPLE_PACKS)
    : CREDIT_PACKS.map(pack => ({ ...pack, displayPrice: formatOrderPrice(pack.cents), price: pack.cents }));
  const base = options.find(option => option.key === CREDIT_PACKS[0].key);
  const choices = options.map(option => ({
    ...option,
    savings: base ? creditPackSavings(option.credits, option.price, base.credits, base.price) : 0,
  }));
  const selected = choices.find(pack => pack.key === packKey) ?? choices[0];

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
      if (selected) void buyCredits(selected.key, source);
    }}>
      <label htmlFor={`${id}-pack`}>Credit pack
        <select id={`${id}-pack`} value={selected?.key ?? ''} disabled={!selected || busy}
          aria-describedby={selected?.savings ? `${id}-savings` : undefined} onChange={event => {
            const next = choices.find(pack => pack.key === event.target.value);
            if (!next) return;
            setPackKey(next.key);
            posthog.capture('billing_credit_amount_changed', { source, provider: apple ? 'apple' : 'stripe', pack_key: next.key });
          }}>
          {!selected && <option value="">Unavailable</option>}
          {choices.map(pack => <option key={pack.key} value={pack.key}>
            {`${pack.credits.toLocaleString()} credits · ${pack.displayPrice}${pack.savings ? ` · ${pack.savings}% off` : ''}`}
          </option>)}
        </select>
      </label>
      {selected?.savings ? <output id={`${id}-savings`} htmlFor={`${id}-pack`} aria-live="polite">
        {selected.savings}% less per credit than the {CREDIT_PACKS[0].credits.toLocaleString()}-credit pack
      </output> : null}
      <button type="submit" className="billing-secondary" disabled={busy || loading || !enabled || !checkoutAvailable || (paid && !selected)}>{busy ? 'Opening…' : 'Buy credits'}</button>
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
