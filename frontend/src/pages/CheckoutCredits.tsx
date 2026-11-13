import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LockKeyhole } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { useBilling } from '../contexts/BillingContext';
import { billingApi } from '../services/billingApi';
import { isAppleApp } from '../services/applePurchases';
import { purchasedCredits } from '../utils/creditPurchase';
import { formatOrderPrice } from '../utils/orderCheckout';
import { CheckoutPayment } from '../components/checkout/CheckoutPayment';
import { SEO } from '../components/SEO';
import './OrderKit.css';
import './CheckoutPlan.css';

type CreditSession = { owner: string; amount: number; session_id: string; client_secret: string };
export default function CheckoutCredits() {
  const [params] = useSearchParams();
  const amount = Number(params.get('amount'));
  const valid = Number.isInteger(amount) && amount >= 50 && amount <= 999999;
  const { user, loading: authLoading } = useAuth();
  const { account, loading, enabled, checkoutAvailable } = useBilling();
  const [session, setSession] = useState<CreditSession | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const eligible = Boolean(account?.has_subscription && account.paid_features);
  const canPay = Boolean(valid && user?.email && !authLoading && !loading && eligible && enabled && checkoutAvailable && !isAppleApp());
  const current = session && session.owner === user?.id && session.amount === amount ? session : null;
  useEffect(() => {
    let active = true;
    setSession(null); setError('');
    if (!canPay || !user) return;
    const owner = user.id;
    posthog.capture('credit_checkout_started', { amount_cents: amount });
    void billingApi.creditCheckout(amount).then(value => {
      if (!active) return;
      if (!value.session_id || !value.client_secret) throw new Error('Secure payment is unavailable. Please try again.');
      setSession({ ...value, owner, amount });
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load payment. Please try again.'); });
    return () => { active = false; };
  }, [canPay, user?.id, amount, attempt]);
  const retry = () => { posthog.capture('credit_checkout_retry_clicked'); setAttempt(value => value + 1); };
  return <div className="order-checkout plan-checkout">
    <SEO title="Credit checkout — BrickBuilder AI" description="Add credits to your BrickBuilder account." url="https://brickbuilder.ai/checkout-credits" noIndex />
    <header className="checkout-header"><div className="checkout-header-inner"><Link to="/" className="checkout-brand"><span><b>BRICK</b>BUILDER</span></Link><span className="checkout-header-secure"><LockKeyhole size={16} />Secure checkout</span></div></header>
    <main className="checkout-main">
      <Link className="checkout-model-back" to="/billing" onClick={event => { if (busy) event.preventDefault(); else posthog.capture('credit_checkout_back_clicked'); }}><ArrowLeft size={16} />Back to billing</Link>
      <div className="checkout-intro"><h1>Checkout</h1></div>
      {!valid ? <p role="alert">Choose a credit amount between $0.50 and $9,999.99.</p> : <div className="checkout-layout">
        <aside className="checkout-summary" aria-label="Credits summary"><div className="checkout-summary-body">
          <p className="checkout-kit-eyebrow">One-time purchase</p><h2>{purchasedCredits(amount, account?.plan_key).toLocaleString()} credits</h2><p>Your purchased credits never expire.</p>
          <dl className="checkout-price-list"><div className="checkout-total"><dt>Total</dt><dd>{formatOrderPrice(amount)}</dd></div></dl>
        </div></aside>
        <section className="checkout-flow"><h2>Payment</h2>
          {authLoading || loading ? <p role="status">Loading your account…</p> : !user ? <p><Link to="/billing">Sign in to buy credits</Link>.</p> : isAppleApp() ? <p>Buy credits using Apple purchases in the app.</p> : !eligible ? <p>A paid plan is required. <Link to="/pricing">Explore plans</Link>.</p> : !enabled || !checkoutAvailable ? <p role="status">Credit purchases are temporarily unavailable.</p> : error ? <div className="checkout-error" role="alert">{error}<button onClick={retry}>Try again</button></div> : current && user.email ? <CheckoutPayment key={current.session_id} session={current} publishableKey={import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''}
            creditPurchase email={user.email} totalCents={amount} onBack={() => {}} onRetry={retry} onBusyChange={setBusy} /> : <p role="status">Loading secure payment…</p>}
        </section>
      </div>}
    </main>
  </div>;
}
