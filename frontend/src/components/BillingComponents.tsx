import { CompatibleBricks } from './CompatibleBricks';
import { GenerationExamples } from './GenerationExamples';
import { GENERATION_SUBSCRIPTION_SOURCE } from '../utils/generationSubscription';
import { PLAN_GENERATIONS, PLAN_DISCOUNTS } from '../utils/planDisplay';
import { CreditPacks } from './CreditPurchase';
export { CreditPacks } from './CreditPurchase';
import { isAppleApp, hasApplePurchases, appleProduct } from '../services/applePurchases';
import { providerKeysApi } from '../services/providerKeysApi';
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Check, Coins, X } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { useBilling } from '../contexts/BillingContext';
import { usePet } from '../contexts/PetContext';
import { PetAvatar } from './PetCompanion';
import LoginModal from './LoginModal';
import { PaidFeatureDialog } from './PaidFeatureDialog';
import type { BillingAccount } from '../services/billingApi';
import './billing.css';

export const billingDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export function CreditBalance() {
  const { user } = useAuth();
  const { account, enabled, openUpgrade } = useBilling();
  if (!user || !enabled) return null;
  return <button type="button" className="credit-balance" aria-label={account ? `${account.credits_remaining} credits. View plans and usage` : 'View credits and plans'}
    onClick={() => openUpgrade('credit_balance')}>
    <Coins size={16} aria-hidden="true" /><span className="credit-count">{account?.credits_remaining.toLocaleString() ?? '…'}</span><span className="credit-label">credits</span>
    <span className="credit-add" aria-hidden="true">+</span>
  </button>;
}

export function PlanGrid({ source, paidOnly = false }: { source: string; paidOnly?: boolean }) {
  const { user } = useAuth();
  const { plans, account, busy, enabled, checkoutAvailable, subscribe, closeUpgrade, appleProducts, restore, retryAccess } = useBilling();
  const apple = isAppleApp();
  const tester = account?.subscription_provider === 'external_tester';
  return <><div className={`billing-plan-grid${paidOnly ? ' billing-plan-grid--paid' : ''}`}>
    {plans.filter(plan => plan.key !== 'free').map(plan => {
      const current = Boolean(user && (account?.subscription_provider === 'apple' ? account.apple_plan : account?.plan_key) === plan.key);
      const applePrice = appleProducts?.find(p => p.id === appleProduct(plan.key))?.displayPrice;
      const petId = plan.key === 'creator' ? 'nib' : 'pip';
      return <article key={plan.key} className={`billing-plan${plan.key === 'creator' ? ' billing-plan--recommended' : ''}`} aria-label={`${plan.name} plan`}>
        {plan.key === 'creator' && <span className="billing-recommendation">Recommended</span>}
        <div className="billing-plan-top"><h2>{plan.name}</h2><PetAvatar id={petId} still /></div>
        <p className="billing-price"><strong>{apple && plan.monthly_cents ? applePrice ?? '—' : `$${plan.monthly_cents / 100}`}</strong><span>/ month</span></p>
        <div className="billing-credit-allocation"><Coins size={17} aria-hidden="true" /><strong>{plan.credits.toLocaleString()}</strong> credits / month</div>
        <p className="billing-set-estimate">{PLAN_GENERATIONS[plan.key]} LEGO® generations per month</p>
        <ul className="billing-features">
          <li className="billing-feature-saving"><Check aria-label="Included" /><strong>{PLAN_DISCOUNTS[plan.key]}% off <CompatibleBricks source="plan_benefit" /></strong></li>
        </ul>
        <button className={`billing-plan-button${plan.key === 'creator' ? ' billing-plan-button--primary' : ''}`} disabled={current || tester || busy || !enabled || !checkoutAvailable || (apple && !applePrice)}
          onClick={() => void subscribe(plan.key, source)}>{current ? 'Current plan' : tester ? 'Unavailable with tester access' : !enabled ? 'Coming soon' : apple && (!hasApplePurchases() || !applePrice) ? 'Unavailable' : !checkoutAvailable ? 'Unavailable' : busy ? 'Opening…' : 'Select Plan'}</button>
        {current && <Link to="/billing" className="billing-current-link" onClick={() => { posthog.capture('billing_usage_clicked', { source }); closeUpgrade(); }}>View usage & billing <ArrowUpRight size={14} /></Link>}
      </article>;
    })}
  </div>{apple && <div className="billing-fine-print">
    {!hasApplePurchases() && <p>Update BrickBuilder from the App Store to subscribe.</p>}
    <p>Payment is charged to your Apple account. Subscriptions renew monthly unless canceled at least 24 hours before renewal. Apple credits roll over and never expire. Paid features last through your subscription period.</p>
    {hasApplePurchases() && !appleProducts.length && <><button className="billing-text-link" disabled={busy} onClick={() => { posthog.capture('billing_apple_retry_clicked'); void retryAccess(); }}>Retry Apple connection</button>{' · '}</>}
    <button className="billing-text-link" disabled={busy} onClick={() => void restore()}>Restore purchases</button>{' · '}
    <Link to="/terms" onClick={() => { posthog.capture('billing_terms_clicked'); closeUpgrade(); }}>Terms of Use</Link>{' · '}
    <Link to="/privacy" onClick={() => { posthog.capture('billing_privacy_clicked'); closeUpgrade(); }}>Privacy Policy</Link>
  </div>}</>;
}

export function CreditNudge() {
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();
  const { user } = useAuth();
  const { account, enabled, openUpgrade } = useBilling();
  const { pet } = usePet();
  const low = Boolean(account && (account.credits_remaining <= Math.max(2, Math.floor(account.monthly_credits * .2))
    || (account.monthly_remaining + (account.apple_remaining ?? 0)) < 20));
  const source = low ? 'low_credits' : 'creation_banner';
  const highest = account?.plan_key === 'creator' || account?.plan_key === 'master';
  useEffect(() => {
    if (!dismissed && enabled && (!account?.has_subscription || low)) posthog.capture('billing_nudge_shown', { source, plan_key: account?.plan_key ?? 'guest' });
  }, [dismissed, enabled, source, account?.plan_key, account?.has_subscription, low]);
  if (dismissed || !enabled || (account?.has_subscription && !low)) return null;
  return <div className={`credit-nudge${low ? ' credit-nudge--low' : ''}`}>
    {low && <PetAvatar still />}
    <p>{low ? <><strong>{pet.name}: {account?.credits_remaining === 0 ? 'Ready for our next build?' : `${account?.credits_remaining} credits left.`}</strong> {highest ? 'Buy additional credits to keep building.' : <>Choose a plan to keep creating{account && account.subscription_provider !== 'apple' && new Date(account.period_end).getTime() > Date.now() ? `, or wait for your reset on ${billingDate(account.period_end)}` : ''}.</>}</>
      : <><strong>More ideas? More bricks.</strong> {isAppleApp() ? 'Monthly subscriptions available through Apple.' : 'Monthly plans from $2.99.'} Basic builds use 2 credits; All parts uses 20. Paid plans also save 10–20% on <CompatibleBricks source="plan_benefit" />.</>}</p>
    <button type="button" onClick={() => { if (low && highest) { posthog.capture('billing_usage_clicked', { source }); navigate('/billing#credit-packs'); } else openUpgrade(source); }}>{low ? highest ? 'Buy credits' : 'Get more credits' : user ? 'Explore plans' : 'See plans'}<ArrowUpRight size={15} aria-hidden="true" /></button>
    <button type="button" className="credit-nudge-dismiss" aria-label="Dismiss plans banner" onClick={() => { setDismissed(true); posthog.capture('billing_nudge_dismissed', { source, plan_key: account?.plan_key ?? 'guest' }); }}><X size={18} aria-hidden="true" /></button>
  </div>;
}

export function MonthlyCreditUsage({ account }: { account: Pick<BillingAccount, 'monthly_credits' | 'monthly_remaining'> }) {
  const total = Math.max(0, account.monthly_credits);
  const used = Math.min(total, Math.max(0, total - account.monthly_remaining));
  return <div className="billing-monthly-usage">
    <p>You’ve used <strong>{used.toLocaleString()}</strong> of your <strong>{total.toLocaleString()}</strong> monthly credits.</p>
    <progress max={Math.max(1, total)} value={used} aria-label="Monthly credits used" aria-valuetext={`${used} of ${total} monthly credits used`} />
  </div>;
}

export function BillingOverlays() {
  const { upgradeSource, closeUpgrade, openUpgrade, account, enabled, error, loginOpen, closeLogin } = useBilling();
  const subscriptionPrompt = upgradeSource === GENERATION_SUBSCRIPTION_SOURCE;
  const loginSource = useRef('');
  if (upgradeSource) loginSource.current = upgradeSource;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!upgradeSource) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [upgradeSource]);
  return <>
    {upgradeSource && <dialog ref={dialog} className="billing-dialog" aria-labelledby="billing-upgrade-title"
      onCancel={e => { e.preventDefault(); closeUpgrade(); }} onClose={closeUpgrade}>
      <button className="billing-close" type="button" aria-label="Close plans" onClick={closeUpgrade}><X size={20} /></button>
      <h1 id="billing-upgrade-title" className={subscriptionPrompt ? 'pr-10 text-xl font-bold text-slate-900' : 'sr-only'}>{subscriptionPrompt ? 'Subscribe to generate models' : 'Plans & credits'}</h1>
      {subscriptionPrompt && <p className="mb-4 mt-2 text-sm text-slate-600">Choose a BrickBuilder AI plan to create or edit models with AI.</p>}
      {account && account.plan_key !== 'free' && <div className="billing-dialog-heading"><PetAvatar /><div><MonthlyCreditUsage account={account} /></div></div>}
      {error && (enabled || account) && <p role="alert" className="billing-error">{error}</p>}
      {!enabled && <p role="status" className="billing-launch-notice">Subscription checkout is temporarily unavailable. Please try again shortly.</p>}
      <p className="billing-member-intro">Every paid plan includes a discount on <CompatibleBricks source="plan_benefit" /></p>
      <PlanGrid source={upgradeSource} paidOnly />
      {subscriptionPrompt ? <GenerationExamples onView={closeUpgrade} /> : <CreditPacks source={upgradeSource} />}
      <p className="billing-fine-print">Cancel anytime</p>
    </dialog>}
    <LoginModal open={loginOpen} onClose={closeLogin} onSuccess={() => { closeLogin(); if (loginSource.current === GENERATION_SUBSCRIPTION_SOURCE) openUpgrade(GENERATION_SUBSCRIPTION_SOURCE); }} redirectTo="/pricing" />
    <PaidFeatureDialog />
  </>;
}


export function GenerationCreditQuote({ allParts, personalSupported = true }: { allParts: boolean; personalSupported?: boolean }) {
  const { user } = useAuth();
  const { enabled, account } = useBilling();
  const [personal, setPersonal] = useState(false);
  useEffect(() => {
    let active = true;
    setPersonal(false);
    const refresh = () => { if (user) void providerKeysApi.status().then(value => { if (active) setPersonal(value.billing_source === 'personal'); }).catch(() => {}); };
    refresh();
    window.addEventListener('brickbuilder:ai-billing-changed', refresh);
    return () => { active = false; window.removeEventListener('brickbuilder:ai-billing-changed', refresh); };
  }, [user?.id]);
  if (personal && personalSupported && account?.paid_features) return <p className="billing-generation-quote" role="status">Your AI account · No BrickBuilder credits used</p>;
  if (!enabled) return null;
  return <p className="billing-generation-quote" role="status">
    {allParts ? '20 credits · All parts / AI mesh conversion' : '2 credits · Basic build or edit'}
    {allParts && account?.paid_features && ` · ${account.monthly_remaining} monthly credits available. Legacy bonuses are for Basic only.`}
    {(!user || account?.paid_features === false) && ' · Subscription required'}
  </p>;
}
