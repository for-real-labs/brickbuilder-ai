import { CompatibleBricks } from '../components/CompatibleBricks';
import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, LockKeyhole } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { useBilling } from '../contexts/BillingContext';
import { billingApi } from '../services/billingApi';
import { isAppleApp } from '../services/applePurchases';
import { CheckoutStep } from '../components/checkout/CheckoutStep';
import { CheckoutPayment } from '../components/checkout/CheckoutPayment';
import { CheckoutAccount } from '../components/checkout/CheckoutAccount';
import { PetAvatar } from '../components/PetCompanion';
import { SEO } from '../components/SEO';
import { PLAN_DISCOUNTS, PLAN_GENERATIONS } from '../utils/planDisplay';
import { formatOrderPrice } from '../utils/orderCheckout';
import './OrderKit.css';
import './CheckoutPlan.css';

type PlanSession = { owner: string; plan: string; session_id: string; client_secret: string };

export default function CheckoutPlan() {
  const { search } = useLocation();
  const navigate = useNavigate();
  const requested = new URLSearchParams(search).get('plan');
  const planKey = requested === 'creator' ? 'creator' : 'builder';
  const valid = requested === null || requested === 'builder' || requested === 'creator';
  const { user, loading: authLoading } = useAuth();
  const { plans, enabled, checkoutAvailable, loading: billingLoading, account } = useBilling();
  const plan = plans.find(item => item.key === planKey);
  const [session, setSession] = useState<PlanSession | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const currentSession = session?.owner === user?.id && session?.plan === planKey ? session : null;
  const canPay = Boolean(user?.email && !authLoading && !billingLoading && enabled && checkoutAvailable && !account?.has_subscription && valid && !isAppleApp());
  useEffect(() => {
    let active = true;
    setSession(null); setError(''); setTotal(null);
    if (!canPay || !user) return;
    const owner = user.id;
    posthog.capture('plan_checkout_started', { plan_key: planKey });
    void billingApi.planCheckout(planKey).then(value => {
      if (!active) return;
      if (!value.client_secret || !value.session_id) throw new Error('Secure payment is unavailable. Please try again.');
      setSession({ ...value, owner, plan: planKey });
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load payment. Please try again.'); });
    return () => { active = false; };
  }, [canPay, user?.id, planKey, attempt]);
  const back = () => { posthog.capture('plan_checkout_back_clicked', { plan_key: planKey }); navigate('/pricing'); };
  return <div className="order-checkout plan-checkout">
    <SEO title="Plan checkout — BrickBuilder AI" description="Subscribe to create with BrickBuilder AI." url="https://brickbuilder.ai/checkout-plan" noIndex />
    <header className="checkout-header"><div className="checkout-header-inner">
      <Link to="/" aria-label="BrickBuilder home" className="checkout-brand"><span><b>BRICK</b>BUILDER</span></Link>
      <span className="checkout-header-secure"><LockKeyhole size={16} />Secure checkout</span>
    </div></header>
    <main className="checkout-main">
      <button className="checkout-model-back" disabled={busy} onClick={back}><ArrowLeft size={16} />Back to plans</button>
      <div className="checkout-intro"><h1>Checkout</h1><nav className="checkout-progress" aria-label="Checkout progress">
        <span className="is-current" aria-current={!user ? 'step' : undefined}><i>{user ? <Check size={12} /> : 1}</i>Create profile *</span>
        <span className={user ? 'is-current' : ''} aria-current={user ? 'step' : undefined}><i>2</i>Payment</span>
      </nav></div>
      {!valid || !plan ? <section className="checkout-empty"><h2>Choose your plan</h2><Link to="/pricing" className="checkout-primary">View plans</Link></section> : isAppleApp() ? <section className="checkout-empty"><h2>Subscribe with Apple</h2><Link to="/pricing" className="checkout-primary">View plans</Link></section> : <div className="checkout-layout">
        <aside className="checkout-summary" aria-label="Plan summary"><div className="checkout-summary-body">
          <p className="checkout-kit-eyebrow">Subscription</p><h2>{plan.name}</h2>
          <div className="plan-checkout-pet"><PetAvatar id={planKey === 'creator' ? 'nib' : 'pip'} /></div>
          <ul className="plan-checkout-benefits">
            <li><Check size={18} />{plan.credits.toLocaleString()} credits each month</li>
            <li><Check size={18} />{PLAN_GENERATIONS[planKey]} LEGO® generations</li>
            <li><Check size={18} /><span>{PLAN_DISCOUNTS[planKey]}% off <CompatibleBricks source="plan_checkout" /></span></li>
          </ul>
          <dl className="checkout-price-list"><div className="checkout-total"><dt>Monthly total</dt><dd>{formatOrderPrice(total ?? plan.monthly_cents)}</dd></div></dl>
          <p className="checkout-pricing-note">USD · Renews monthly until canceled. Credits reset monthly and do not roll over. Cancel anytime in Billing.</p>
        </div></aside>
        <div className="checkout-flow">
          {authLoading ? <p role="status">Loading your profile…</p> : <>
            <CheckoutStep title="Create profile *" number={1} active={!user} complete={!!user} disabled={busy || !!user} onEdit={() => {}}>
              <CheckoutAccount redirectPath={`/checkout-plan?plan=${planKey}`} />
            </CheckoutStep>
            {user && <p className="plan-checkout-signed-in">Signed in as {user.email}</p>}
            <CheckoutStep title="Payment" number={2} active={!!user} complete={false} disabled={!user || busy} onEdit={() => {}}>
              {billingLoading ? <p role="status">Loading your plan…</p> : account?.has_subscription ? <p>You already have a subscription. <Link to="/billing">Manage your plan in Billing</Link>.</p> : !enabled || !checkoutAvailable ? <p role="status">New subscriptions are temporarily unavailable. Please try again later.</p> : error ? <div className="checkout-error" role="alert">{error}<button onClick={() => { posthog.capture('plan_checkout_retry_clicked', { plan_key: planKey }); setAttempt(value => value + 1); }}>Try again</button><Link to="/billing">View billing</Link></div> : currentSession && user?.email ? <CheckoutPayment key={currentSession.session_id} session={currentSession}
                publishableKey={import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || ''} subscriptionPlan={planKey} email={user.email} totalCents={plan.monthly_cents}
                onBack={back} onRetry={() => setAttempt(value => value + 1)} onBusyChange={setBusy} onTotalChange={setTotal} /> : <p role="status">Loading secure payment…</p>}
            </CheckoutStep>
          </>}
        </div>
      </div>}
    </main>
  </div>;
}
