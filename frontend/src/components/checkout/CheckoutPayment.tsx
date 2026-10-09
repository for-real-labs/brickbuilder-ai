import React from 'react';
import { loadStripe } from '@stripe/stripe-js/pure';
import type { Appearance, StripeCheckoutLoadActionsResult, StripePaymentElement, StripeCheckoutExpressCheckoutElement, StripeExpressCheckoutElementConfirmEvent } from '@stripe/stripe-js';
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

export function CheckoutPayment({ session, publishableKey, details, country, totalCents, generationId, onBack, onRetry, onBusyChange }: {
  session: CreateCheckoutSessionResponse; publishableKey: string;
  details: DeliveryDetails; country: string; totalCents: number;
  generationId?: string; onBack: () => void; onRetry: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const mountRef = React.useRef<HTMLDivElement>(null);
  const walletMountRef = React.useRef<HTMLDivElement>(null);
  const walletRef = React.useRef<StripeCheckoutExpressCheckoutElement | null>(null);
  const [selectedMethod, setSelectedMethod] = React.useState<'card' | 'applePay' | 'googlePay'>('card');
  const [wallets, setWallets] = React.useState({ applePay: false, googlePay: false });
  const acceptedRef = React.useRef(false);
  const confirmRef = React.useRef<(event: StripeExpressCheckoutElementConfirmEvent) => Promise<void>>(async () => {});
  const actionsRef = React.useRef<CheckoutActions | null>(null);
  const methodRef = React.useRef<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [accepted, setAccepted] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    let disposed = false;
    let element: StripePaymentElement | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    const fail = () => {
      if (disposed) return;
      setLoadFailed(true);
      setError('Payment could not load. Please try again.');
      posthog.capture('order_checkout_error', { generation_id: generationId, stage: 'payment_load' });
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
          paymentMethodOrder: ['card'],
          wallets: { applePay: 'never', googlePay: 'never', link: 'never' },
        });
        element.on('ready', () => {
          if (disposed) return;
          clearTimeout(timeout); setReady(true); setError(null); setLoadFailed(false);
          posthog.capture('order_payment_loaded', { generation_id: generationId });
        });
        element.on('loaderror', fail);
        element.on('change', event => {
          if (!disposed && methodRef.current !== event.value.type) {
            methodRef.current = event.value.type;
            posthog.capture('order_payment_method_selected', { generation_id: generationId, payment_method: event.value.type });
          }
        });
        if (mountRef.current) element.mount(mountRef.current);
        const wallet = checkout.createExpressCheckoutElement({
          buttonHeight: 52, buttonTheme: { applePay: 'black', googlePay: 'black' }, buttonType: { applePay: 'pay', googlePay: 'pay' },
          layout: { maxColumns: 1, maxRows: 1, overflow: 'never' },
          paymentMethodOrder: ['apple_pay', 'google_pay'],
          paymentMethods: { applePay: 'always', googlePay: 'always', paypal: 'never', link: 'never', amazonPay: 'never', klarna: 'never' },
        });
        walletRef.current = wallet;
        let checkedAvailability = false;
        wallet.on('ready', event => {
          if (disposed || checkedAvailability) return;
          checkedAvailability = true;
          setWallets({ applePay: !!event.availablePaymentMethods?.applePay, googlePay: !!event.availablePaymentMethods?.googlePay });
        });
        wallet.on('click', event => {
          if (acceptedRef.current) event.resolve();
          else setError('Please agree to the Terms of Service before paying.');
        });
        wallet.on('confirm', event => { void confirmRef.current(event); });
        wallet.on('loaderror', () => {
          if (!disposed) setWallets({ applePay: false, googlePay: false });
        });
        if (walletMountRef.current) wallet.mount(walletMountRef.current);
      } catch { clearTimeout(timeout); fail(); }
    })();
    return () => { disposed = true; clearTimeout(timeout); element?.destroy(); walletRef.current?.destroy(); walletRef.current = null; actionsRef.current = null; };
  }, [session.client_secret, publishableKey, generationId]);

  const confirmPayment = async (walletEvent?: StripeExpressCheckoutElementConfirmEvent) => {
    if (!ready || loading || !accepted) return;
    setLoading(true); onBusyChange?.(true); setError(null);
    posthog.capture('order_checkout_clicked', { generation_id: generationId, total_cents: totalCents, currency: 'USD', checkout_mode: 'elements' });
    try {
      if (!actionsRef.current) throw new Error('Payment unavailable');
      const result = await actionsRef.current.confirm({
        email: details.email.trim(),
        ...(!session.shipping_address_provided ? { shippingAddress: getShippingContact(details, country) } : {}),
        redirect: 'if_required',
        ...(walletEvent ? { expressCheckoutConfirmEvent: walletEvent } : {}),
      });
      if (result.type === 'error') { setError(result.error.message); posthog.capture('order_checkout_error', { generation_id: generationId, stage: 'confirm', error_code: result.error.code }); }
      else {
        posthog.capture('order_payment_submitted', { generation_id: generationId });
        window.location.assign(`/success?session_id=${encodeURIComponent(session.session_id)}`);
      }
    } catch {
      setError('Payment could not be completed. Please try again.');
      posthog.capture('order_checkout_error', { generation_id: generationId, stage: 'confirm' });
    } finally { setLoading(false); onBusyChange?.(false); }
  };

  acceptedRef.current = accepted;
  confirmRef.current = confirmPayment;
  const chooseMethod = (method: 'card' | 'applePay' | 'googlePay') => {
    setSelectedMethod(method); setError(null);
    if (method !== 'card') walletRef.current?.update({ paymentMethods: {
      applePay: method === 'applePay' ? 'always' : 'never', googlePay: method === 'googlePay' ? 'always' : 'never',
      paypal: 'never', link: 'never', amazonPay: 'never', klarna: 'never',
    } });
    posthog.capture('order_payment_method_selected', { generation_id: generationId, payment_method: method });
  };
  return <form onSubmit={event => { event.preventDefault(); if (selectedMethod === 'card') void confirmPayment(); }}>
    {!ready && !loadFailed && <div role="status" className="checkout-payment-loading"><span className="checkout-spinner" />Loading secure payment…</div>}
    <div className="checkout-payment-methods" role="radiogroup" aria-label="Payment method">
      <section className={`checkout-payment-option ${selectedMethod === 'card' ? 'is-selected' : ''}`}>
        <button type="button" role="radio" aria-checked={selectedMethod === 'card'} disabled={loading} onClick={() => chooseMethod('card')}><span className="checkout-method-radio" />Card payment<span aria-hidden="true" className="checkout-method-mark">VISA · Mastercard</span></button>
        <div hidden={selectedMethod !== 'card'} ref={mountRef} className="checkout-payment-element" aria-label="Secure payment details" />
      </section>
      <section className={`checkout-payment-option ${selectedMethod === 'applePay' ? 'is-selected' : ''}`}>
        <button type="button" role="radio" aria-checked={selectedMethod === 'applePay'} aria-describedby={!wallets.applePay ? 'apple-pay-unavailable' : undefined} disabled={loading || !wallets.applePay} onClick={() => chooseMethod('applePay')}><span className="checkout-method-radio" />Apple Pay<span aria-hidden="true" className="checkout-method-mark">Apple Pay</span></button>
        {!wallets.applePay && <p id="apple-pay-unavailable" className="checkout-method-note">{window.location.protocol === 'http:' ? 'Available on secure HTTPS checkout.' : 'Unavailable in this browser or device.'}</p>}
      </section>
      <section className="checkout-payment-option">
        <button type="button" role="radio" aria-checked={false} disabled aria-describedby="paypal-unavailable"><span className="checkout-method-radio" />PayPal<span aria-hidden="true" className="checkout-method-mark">PayPal</span></button>
        <p id="paypal-unavailable" className="checkout-method-note">PayPal is not available yet.</p>
      </section>
      <section className={`checkout-payment-option ${selectedMethod === 'googlePay' ? 'is-selected' : ''}`}>
        <button type="button" role="radio" aria-checked={selectedMethod === 'googlePay'} aria-describedby={!wallets.googlePay ? 'google-pay-unavailable' : undefined} disabled={loading || !wallets.googlePay} onClick={() => chooseMethod('googlePay')}><span className="checkout-method-radio" />Google Pay<span aria-hidden="true" className="checkout-method-mark">Google Pay</span></button>
        {!wallets.googlePay && <p id="google-pay-unavailable" className="checkout-method-note">{window.location.protocol === 'http:' ? 'Available on secure HTTPS checkout.' : 'Unavailable in this browser or device.'}</p>}
      </section>
    </div>
    {error && <div role="alert" className="checkout-error">{error}{loadFailed && <button type="button" onClick={() => {
      posthog.capture('order_payment_retry_clicked', { generation_id: generationId }); onRetry();
    }}>Try again</button>}</div>}
    <label className="checkout-consent">
      <input type="checkbox" required checked={accepted} disabled={loading} onChange={event => {
        setAccepted(event.target.checked);
        posthog.capture('order_terms_changed', { generation_id: generationId, accepted: event.target.checked });
      }} />
      <span>I agree to the <a href="/terms" target="_blank" rel="noreferrer" onClick={() => posthog.capture('order_terms_opened', { generation_id: generationId })}>Terms of Service</a>.</span>
    </label>
    <div className="checkout-actions">
      <button type="button" className="checkout-back" aria-label="Back to contact and delivery" disabled={loading} onClick={onBack}><ArrowLeft size={22} /></button>
      <button hidden={selectedMethod !== 'card'} type="submit" className="checkout-primary" disabled={!ready || !accepted || loading || loadFailed}>
        {loading ? 'Processing…' : `Pay ${formatOrderPrice(totalCents)}`}
      </button>
    </div>
    <div className={`checkout-wallet-payment ${selectedMethod === 'card' ? 'is-inactive' : ''}`} aria-hidden={selectedMethod === 'card'}>
      {!accepted && <p className="checkout-method-note">Agree to the Terms of Service to continue with your wallet.</p>}
      <div className={!accepted || loading ? 'is-inactive' : undefined} aria-hidden={!accepted || loading} ref={walletMountRef} />
      {loading && <p role="status">Processing…</p>}
    </div>
    <p className="checkout-secure-note"><LockKeyhole size={14} />Secure, encrypted payment</p>
  </form>;
}
