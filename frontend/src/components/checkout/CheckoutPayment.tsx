import React from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Appearance, StripeCheckoutLoadActionsResult, StripePaymentElement, StripeCheckoutExpressCheckoutElement, StripeExpressCheckoutElement, StripeExpressCheckoutElementConfirmEvent } from '@stripe/stripe-js';
import { ArrowLeft, LockKeyhole } from 'lucide-react';
import posthog from 'posthog-js';
import type { CreateCheckoutSessionResponse } from '../../services/createCheckoutSessionApi';
import { type DeliveryDetails, getShippingContact, formatOrderPrice } from '../../utils/orderCheckout';

type CheckoutActions = Extract<StripeCheckoutLoadActionsResult, { type: 'success' }>['actions'];
const checkoutAppearance: Appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary: '#f44336', colorText: '#202124', colorTextSecondary: '#636971',
    colorBackground: '#ffffff', colorDanger: '#b42318', fontFamily: 'Arial, sans-serif',
    fontSizeBase: '16px', borderRadius: '16px', spacingUnit: '5px',
  },
  rules: {
    '.Input': { backgroundColor: '#f5f5f6', border: '1px solid #9299a3', borderRadius: '10px', padding: '15px 16px', boxShadow: 'none' },
    '.Input:focus': { borderColor: '#f44336', boxShadow: '0 0 0 1px #f44336' },
    '.Label': { fontWeight: '400', marginBottom: '8px' },
    '.AccordionItem': { border: '2px solid #e4e7eb', borderRadius: '20px', boxShadow: '0 3px 9px rgba(20, 25, 30, 0.03)' },
    '.AccordionItem--selected': { borderColor: '#f44336', boxShadow: 'none' },
  },
};

type PaymentCustomer = { subscriptionPlan: 'builder' | 'creator'; email: string; details?: never; country?: never }
  | { subscriptionPlan?: undefined; email?: never; details: DeliveryDetails; country: string };

export function CheckoutPayment({ session, publishableKey, details, country, totalCents, generationId, subscriptionPlan, email, onBack, onRetry, onBusyChange, onTotalChange }: PaymentCustomer & {
  session: CreateCheckoutSessionResponse; publishableKey: string;
  totalCents: number;
  generationId?: string; onBack: () => void; onRetry: () => void;
  onBusyChange?: (busy: boolean) => void;
  onTotalChange?: (total: number) => void;
}) {
  const track = (event: string, properties: Record<string, unknown> = {}) => posthog.capture(
    subscriptionPlan ? event.replace(/^order_/, 'plan_') : event,
    { ...properties, ...(subscriptionPlan ? { plan_key: subscriptionPlan } : {}) },
  );
  const mountRef = React.useRef<HTMLDivElement>(null);
  const walletMountRef = React.useRef<HTMLDivElement>(null);
  const walletRef = React.useRef<StripeCheckoutExpressCheckoutElement | null>(null);
  const [selectedMethod, setSelectedMethod] = React.useState<'card' | 'applePay' | 'googlePay'>('card');
  const [wallets, setWallets] = React.useState({ applePay: false, googlePay: false });
  const [walletStatus, setWalletStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const selectedMethodRef = React.useRef(selectedMethod);
  const acceptedRef = React.useRef(false);
  const confirmRef = React.useRef<(event: StripeExpressCheckoutElementConfirmEvent) => Promise<void>>(async () => {});
  const actionsRef = React.useRef<CheckoutActions | null>(null);
  const methodRef = React.useRef<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [promoCode, setPromoCode] = React.useState('');
  const [appliedCode, setAppliedCode] = React.useState('');
  const [promoBusy, setPromoBusy] = React.useState(false);
  const [promoError, setPromoError] = React.useState<string | null>(null);
  const [paymentTotal, setPaymentTotal] = React.useState(totalCents);
  const operationRef = React.useRef(false);
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    let disposed = false;
    let element: StripePaymentElement | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const fail = () => {
      if (disposed) return;
      setLoadFailed(true);
      setError('Payment could not load. Please try again.');
      track('order_checkout_error', { generation_id: generationId, stage: 'payment_load' });
    };
    timeout = setTimeout(fail, 20000);
    void (async () => {
      try {
        if (!session.client_secret || !publishableKey) throw new Error('Payment configuration unavailable');
        const stripe = await loadStripe(publishableKey);
        if (disposed) return;
        if (!stripe) throw new Error('Stripe unavailable');
        const checkout = stripe.initCheckoutElementsSdk({ clientSecret: session.client_secret, elementsOptions: { appearance: checkoutAppearance } });
        const result = await checkout.loadActions();
        if (disposed) return;
        if (result.type === 'error') throw new Error(result.error.message);
        actionsRef.current = result.actions;
        element = checkout.createPaymentElement({
          layout: 'tabs',
          ...(subscriptionPlan ? { fields: { billingDetails: { address: 'if_required' as const } } } : {}),
          paymentMethodOrder: ['card'],
          wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
        });
        element.on('ready', () => {
          if (disposed) return;
          clearTimeout(timeout); setReady(true); setError(null); setLoadFailed(false);
          track('order_payment_loaded', { generation_id: generationId });
        });
        element.on('loaderror', fail);
        element.on('change', event => {
          if (!disposed && methodRef.current !== event.value.type) {
            methodRef.current = event.value.type;
            track('order_payment_method_selected', { generation_id: generationId, payment_method: event.value.type });
          }
        });
        if (mountRef.current) element.mount(mountRef.current);
        try {
          const wallet = checkout.createExpressCheckoutElement({
            buttonHeight: 52, buttonTheme: { applePay: 'black', googlePay: 'black' }, buttonType: { applePay: 'pay', googlePay: 'pay' },
            layout: { maxColumns: 1, maxRows: 0, overflow: 'never' },
            paymentMethodOrder: ['apple_pay', 'google_pay'],
            paymentMethods: { applePay: 'always', googlePay: 'always', paypal: 'never', link: 'never', amazonPay: 'never', klarna: 'never' },
          }) as StripeExpressCheckoutElement;
          walletRef.current = wallet;
          const updateWallets = (available: { applePay: boolean; googlePay: boolean }) => {
            if (disposed) return;
            setWalletStatus('ready');
            // Selecting one wallet hides the other in Stripe; retain its eligibility.
            setWallets(previous => ({
              applePay: selectedMethodRef.current === 'googlePay' ? previous.applePay : available.applePay,
              googlePay: selectedMethodRef.current === 'applePay' ? previous.googlePay : available.googlePay,
            }));
          };
          let availabilityReported = false;
          wallet.on('ready', event => {
            if (availabilityReported) return;
            updateWallets({ applePay: !!event.availablePaymentMethods?.applePay, googlePay: !!event.availablePaymentMethods?.googlePay });
          });
          wallet.on('availablepaymentmethodschange', event => {
            availabilityReported = true;
            updateWallets({ applePay: !!event.paymentMethods?.applePay?.available, googlePay: !!event.paymentMethods?.googlePay?.available });
          });
          wallet.on('click', event => {
            if (acceptedRef.current) event.resolve();
            else setError('Please agree to the Terms of Service before paying.');
          });
          wallet.on('confirm', event => { void confirmRef.current(event); });
          wallet.on('loaderror', () => {
            if (!disposed) { setWalletStatus('error'); setWallets({ applePay: false, googlePay: false }); }
          });
          if (walletMountRef.current) wallet.mount(walletMountRef.current);
        } catch {
          if (!disposed) {
            setWalletStatus('error');
            track('order_checkout_error', { generation_id: generationId, stage: 'wallet_load' });
          }
        }
      } catch { clearTimeout(timeout); fail(); }
    })();
    return () => { disposed = true; clearTimeout(timeout); element?.destroy(); walletRef.current?.destroy(); walletRef.current = null; actionsRef.current = null; };
  }, [session.client_secret, publishableKey, generationId, subscriptionPlan]);

  const confirmPayment = async (walletEvent?: StripeExpressCheckoutElementConfirmEvent) => {
    if (!ready || operationRef.current || !accepted) return;
    operationRef.current = true;
    setLoading(true); onBusyChange?.(true); setError(null);
    track('order_checkout_clicked', { generation_id: generationId, total_cents: paymentTotal, currency: 'USD', checkout_mode: 'elements' });
    try {
      if (!actionsRef.current) throw new Error('Payment unavailable');
      const result = await actionsRef.current.confirm({
        ...(!subscriptionPlan ? { email: details.email.trim() } : {}),
        ...(!subscriptionPlan && !session.shipping_address_provided ? { shippingAddress: getShippingContact(details, country) } : {}),
        redirect: 'if_required',
        ...(walletEvent ? { expressCheckoutConfirmEvent: walletEvent } : {}),
      });
      if (result.type === 'error') { setError(result.error.message); track('order_checkout_error', { generation_id: generationId, stage: 'confirm', error_code: result.error.code }); }
      else {
        track('order_payment_submitted', { generation_id: generationId });
        window.location.assign(`${subscriptionPlan ? '/billing?checkout=success&' : '/success?'}session_id=${encodeURIComponent(session.session_id)}`);
      }
    } catch {
      setError('Payment could not be completed. Please try again.');
      track('order_checkout_error', { generation_id: generationId, stage: 'confirm' });
    } finally { operationRef.current = false; setLoading(false); onBusyChange?.(false); }
  };

  const updatePromo = async (remove = false) => {
    if (!ready || operationRef.current || !actionsRef.current || (!remove && !promoCode.trim())) return;
    operationRef.current = true;
    setPromoBusy(true); onBusyChange?.(true); setPromoError(null);
    try {
      const result = remove ? await actionsRef.current.removePromotionCode() : await actionsRef.current.applyPromotionCode(promoCode.trim());
      if (result.type === 'error') {
        setPromoError(result.error.message);
        track('order_promo_failed', { generation_id: generationId });
      } else {
        const total = result.session.total.total.minorUnitsAmount;
        setPaymentTotal(total); onTotalChange?.(total);
        setAppliedCode(remove ? '' : promoCode.trim());
        if (remove) setPromoCode('');
        posthog.capture(remove ? 'order_promo_removed' : 'order_promo_applied', { generation_id: generationId, total_cents: total });
      }
    } catch {
      setPromoError('Could not update the promo code. Please try again.');
      track('order_promo_failed', { generation_id: generationId });
    } finally { operationRef.current = false; setPromoBusy(false); onBusyChange?.(false); }
  };

  acceptedRef.current = accepted && !promoBusy;
  confirmRef.current = confirmPayment;
  const chooseMethod = (method: 'card' | 'applePay' | 'googlePay') => {
    selectedMethodRef.current = method;
    setSelectedMethod(method); setError(null);
    walletRef.current?.update({ paymentMethods: {
      applePay: method !== 'googlePay' ? 'always' : 'never', googlePay: method !== 'applePay' ? 'always' : 'never',
      paypal: 'never', link: 'never', amazonPay: 'never', klarna: 'never',
    } });
    track('order_payment_method_selected', { generation_id: generationId, payment_method: method });
  };
  const walletNote = walletStatus === 'loading' ? 'Checking wallet availability…'
    : walletStatus === 'error' ? 'Wallet payment could not load. Refresh the page or pay by card.'
      : window.location.protocol === 'http:' ? 'Available on secure HTTPS checkout.' : 'Not supported by this browser or wallet setup.';
  return <form onSubmit={event => { event.preventDefault(); if (selectedMethod === 'card') void confirmPayment(); }}>
    {!ready && !loadFailed && <div role="status" className="checkout-payment-loading"><span className="checkout-spinner" />Loading secure payment…</div>}
    {!subscriptionPlan && <div className="checkout-promo">
      <label className="checkout-field" htmlFor="order-promo"><span>Promo code</span>
        <input id="order-promo" value={promoCode} autoComplete="off" maxLength={100} disabled={!ready || loading || promoBusy || !!appliedCode}
          onChange={event => setPromoCode(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void updatePromo(); } }} />
      </label>
      <button type="button" className="checkout-promo-button" disabled={!ready || loading || promoBusy || (!appliedCode && !promoCode.trim())} onClick={() => void updatePromo(!!appliedCode)}>
        {promoBusy ? 'Updating…' : appliedCode ? 'Remove' : 'Apply'}
      </button>
      {appliedCode && <p role="status">{appliedCode} applied. Total: {formatOrderPrice(paymentTotal)}</p>}
      {promoError && <p role="alert" className="checkout-error">{promoError}</p>}
    </div>}
    <div className="checkout-payment-methods" role="radiogroup" aria-label="Payment method">
      <section className={`checkout-payment-option ${selectedMethod === 'card' ? 'is-selected' : ''}`}>
        <button type="button" role="radio" aria-checked={selectedMethod === 'card'} disabled={loading || promoBusy} onClick={() => chooseMethod('card')}><span className="checkout-method-radio" />Card payment<span aria-hidden="true" className="checkout-method-mark">VISA · Mastercard</span></button>
        <div hidden={selectedMethod !== 'card'} ref={mountRef} className="checkout-payment-element" aria-label="Secure payment details" />
      </section>
      <section className={`checkout-payment-option ${selectedMethod === 'applePay' ? 'is-selected' : ''}`}>
        <button type="button" role="radio" aria-checked={selectedMethod === 'applePay'} aria-describedby={!wallets.applePay ? 'apple-pay-unavailable' : undefined} disabled={loading || promoBusy || !wallets.applePay} onClick={() => chooseMethod('applePay')}><span className="checkout-method-radio" />Apple Pay<span aria-hidden="true" className="checkout-method-mark">Apple Pay</span></button>
        {!wallets.applePay && <p id="apple-pay-unavailable" className="checkout-method-note">{walletNote}</p>}
      </section>
      <section className={`checkout-payment-option ${selectedMethod === 'googlePay' ? 'is-selected' : ''}`}>
        <button type="button" role="radio" aria-checked={selectedMethod === 'googlePay'} aria-describedby={!wallets.googlePay ? 'google-pay-unavailable' : undefined} disabled={loading || promoBusy || !wallets.googlePay} onClick={() => chooseMethod('googlePay')}><span className="checkout-method-radio" />Google Pay<span aria-hidden="true" className="checkout-method-mark">Google Pay</span></button>
        {!wallets.googlePay && <p id="google-pay-unavailable" className="checkout-method-note">{walletNote}</p>}
      </section>
    </div>
    {error && <div role="alert" className="checkout-error">{error}{loadFailed && <button type="button" onClick={() => {
      track('order_payment_retry_clicked', { generation_id: generationId }); onRetry();
    }}>Try again</button>}</div>}
    {subscriptionPlan && <p className="checkout-section-note">Renews monthly until canceled. Credits reset monthly and do not roll over. Cancel anytime in Billing; access continues through your paid period.</p>}
    <label className="checkout-consent">
      <input type="checkbox" required checked={accepted} disabled={loading || promoBusy} onChange={event => {
        setAccepted(event.target.checked);
        track('order_terms_changed', { generation_id: generationId, accepted: event.target.checked });
      }} />
      <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer" onClick={() => track('order_terms_opened', { generation_id: generationId })}>Terms of Service</a>.</span>
    </label>
    <div className="checkout-actions">
      {!subscriptionPlan && <button type="button" className="checkout-back" aria-label="Back to contact and delivery" disabled={loading || promoBusy} onClick={onBack}><ArrowLeft size={22} /></button>}
      <button hidden={selectedMethod !== 'card'} type="submit" className="checkout-primary" disabled={!ready || !accepted || loading || promoBusy || loadFailed}>
        {loading ? 'Processing…' : subscriptionPlan ? `Subscribe · ${formatOrderPrice(paymentTotal)} / month` : `Pay ${formatOrderPrice(paymentTotal)}`}
      </button>
    </div>
    <div className={`checkout-wallet-payment ${selectedMethod === 'card' ? 'is-inactive' : ''}`} aria-hidden={selectedMethod === 'card'}>
      {!accepted && <p className="checkout-method-note">Agree to the Terms of Service to continue with your wallet.</p>}
      <div className={!accepted || loading || promoBusy ? 'is-inactive' : undefined} aria-hidden={!accepted || loading || promoBusy} ref={walletMountRef} />
      {loading && <p role="status">Processing…</p>}
    </div>
    <p className="checkout-secure-note"><LockKeyhole size={14} />Secure, encrypted payment</p>
  </form>;
}
