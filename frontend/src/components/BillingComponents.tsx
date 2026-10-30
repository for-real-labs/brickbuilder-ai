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
import type { BillingAccount, PlanKey } from '../services/billingApi';
import './billing.css';

export const billingDate = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const descriptions: Record<PlanKey, string> = {
  free: 'Room to try your ideas.', builder: 'For your next weekend project.',
  creator: 'For builders with a growing idea list.', master: 'For a whole world of possibilities.',
};

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
  return <><div className={`billing-plan-grid${paidOnly ? ' billing-plan-grid--paid' : ''}`}>
    {plans.filter(plan => !paidOnly || plan.key !== 'free').map(plan => {
      const current = Boolean(user && (account?.subscription_provider === 'apple' ? account.apple_plan : account?.plan_key) === plan.key);
      const applePrice = appleProducts?.find(p => p.id === appleProduct(plan.key))?.displayPrice;
      const petId = plan.key === 'creator' ? 'nib' : 'pip';
      return <article key={plan.key} className={`billing-plan${plan.key === 'free' ? ' billing-plan--free' : ''}${plan.key === 'creator' ? ' billing-plan--recommended' : ''}`} aria-label={`${plan.name} plan`}>
        {plan.key === 'creator' && <span className="billing-recommendation">Recommended</span>}
        <div className="billing-plan-top"><h2>{plan.name}</h2><PetAvatar id={petId} still /></div>
        <p className="billing-plan-description">{descriptions[plan.key]}</p>
        <p className="billing-price"><strong>{apple && plan.monthly_cents ? applePrice ?? '—' : `$${plan.monthly_cents / 100}`}</strong><span>/ month</span></p>
        <p className="billing-renewal">{plan.monthly_cents ? apple ? 'Billed monthly by Apple' : 'USD · billed monthly' : 'No credit card needed'}</p>
        <div className="billing-credit-allocation"><Coins size={17} aria-hidden="true" /><strong>{plan.credits.toLocaleString()}</strong> credits / month</div>
        <ul className="billing-features">
          <li><Check aria-hidden="true" />LDR model downloads</li>
          <li className={plan.key === 'free' ? 'billing-feature-unavailable' : ''}>{plan.key === 'free' ? <X aria-label="Not included" /> : <Check aria-label="Included" />}IO model exports</li>
          <li><Check aria-hidden="true" />Building instructions</li>
          <li className={plan.key === 'free' ? 'billing-feature-unavailable' : 'billing-feature-saving'}>
            {plan.key === 'free' ? <X aria-label="Not included" /> : <Check aria-label="Included" />}
            <span><strong>20% off every model purchase</strong><small>Physical model bricks · promo codes stack</small></span>
          </li>
        </ul>
        {plan.key === 'free' ? user ? <button className="billing-plan-button" disabled>{current ? 'Current plan' : 'Free after cancellation'}</button>
          : <button className="billing-plan-button" onClick={() => void subscribe('free', source)}>Start building free</button>
          : <button className={`billing-plan-button${plan.key === 'creator' ? ' billing-plan-button--primary' : ''}`} disabled={current || busy || !enabled || !checkoutAvailable || (apple && !applePrice)}
            onClick={() => void subscribe(plan.key, source)}>{current ? 'Current plan' : !enabled ? 'Coming soon' : apple && (!hasApplePurchases() || !applePrice) ? 'Unavailable' : !checkoutAvailable ? 'Unavailable' : busy ? 'Opening…' : `Choose ${plan.name}`}</button>}
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
    || (account.monthly_remaining + (account.apple_remaining ?? 0)) < 15));
  const source = low ? 'low_credits' : 'creation_banner';
  const highest = account?.plan_key === 'creator' || account?.plan_key === 'master';
  useEffect(() => {
    if (!dismissed && enabled && (!account?.has_subscription || low)) posthog.capture('billing_nudge_shown', { source, plan_key: account?.plan_key ?? 'guest' });
  }, [dismissed, enabled, source, account?.plan_key, account?.has_subscription, low]);
  if (dismissed || !enabled || (account?.has_subscription && !low)) return null;
  return <div className={`credit-nudge${low ? ' credit-nudge--low' : ''}`}>
    {low && <PetAvatar still />}
    <p>{low ? <><strong>{pet.name}: {account?.credits_remaining === 0 ? 'Ready for our next build?' : `${account?.credits_remaining} credits left.`}</strong> {highest ? 'Buy additional credits to keep building.' : <>Choose a plan to keep creating{account && account.subscription_provider !== 'apple' && new Date(account.period_end).getTime() > Date.now() ? `, or wait for your reset on ${billingDate(account.period_end)}` : ''}.</>}</>
      : <><strong>More ideas? More bricks.</strong> {isAppleApp() ? 'Monthly subscriptions available through Apple.' : 'Monthly plans from $9.'} Basic builds use 1 credit; All parts uses 15. Paid plans also save 20% on model bricks.</>}</p>
    <button type="button" onClick={() => { if (low && highest) { posthog.capture('billing_usage_clicked', { source }); navigate('/billing#credit-packs'); } else openUpgrade(source); }}>{low ? highest ? 'Buy more credits' : 'Get more credits' : user ? 'Explore plans' : 'See plans'}<ArrowUpRight size={15} aria-hidden="true" /></button>
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
  const { upgradeSource, closeUpgrade, account, enabled, error, loginOpen, closeLogin } = useBilling();
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
      <div className="billing-dialog-heading"><PetAvatar /><div>
        <h1 id="billing-upgrade-title">{upgradeSource === 'credits_exhausted' ? 'Let’s make room for your next idea.' : 'Your next big idea starts here.'}</h1>
        {account && <MonthlyCreditUsage account={account} />}
      </div></div>
      {error && (enabled || account) && <p role="alert" className="billing-error">{error}</p>}
      {!enabled && <p role="status" className="billing-launch-notice">Monthly plans are getting ready. Your current building access continues.</p>}
      <p className="billing-member-intro">Every paid plan includes 20% off model bricks. Applied automatically at checkout, with promo codes on top.</p>
      <PlanGrid source={upgradeSource} paidOnly />
      <CreditPacks source={upgradeSource} />
      <p className="billing-fine-print">Plans renew monthly until canceled. {isAppleApp() ? 'Apple credits roll over and never expire.' : 'Web monthly credits reset and do not roll over.'} Legacy bonuses never expire. Failed or canceled builds return their credits.</p>
      <Link to="/billing" className="billing-text-link" onClick={() => { posthog.capture('billing_usage_clicked', { source: upgradeSource }); closeUpgrade(); }}>View credit history & manage subscription</Link>
    </dialog>}
    <LoginModal open={loginOpen} onClose={closeLogin} onSuccess={closeLogin} redirectTo="/pricing" />
    <PaidFeatureDialog />
  </>;
}


export function GenerationCreditQuote({ allParts, personalSupported = true }: { allParts: boolean; personalSupported?: boolean }) {
  const { user } = useAuth();
  const { enabled, account, signIn } = useBilling();
  const [personal, setPersonal] = useState(false);
  useEffect(() => {
    let active = true;
    setPersonal(false);
    const refresh = () => { if (user) void providerKeysApi.status().then(value => { if (active) setPersonal(value.billing_source === 'personal'); }).catch(() => {}); };
    refresh();
    window.addEventListener('brickbuilder:ai-billing-changed', refresh);
    return () => { active = false; window.removeEventListener('brickbuilder:ai-billing-changed', refresh); };
  }, [user?.id]);
  if (personal && personalSupported) return <p className="billing-generation-quote" role="status">Your AI account · No BrickBuilder credits used</p>;
  if (!enabled) return null;
  return <p className="billing-generation-quote" role="status">
    {allParts ? '15 credits · All parts / AI mesh conversion' : '1 credit · Basic build or edit'}
    {allParts && account && ` · ${account.monthly_remaining} monthly credits available. Legacy bonuses are for Basic only.`}
    {!user && <> · 75 lifetime guest credits: 5 All parts builds or 75 Basic builds, or a mix. No login needed.{' '}
      <button type="button" className="billing-text-link" onClick={() => { posthog.capture('billing_mode_sign_in_clicked', { mode: allParts ? 'all_parts' : 'basic' }); signIn(); }}>Sign in for 300 free monthly credits</button></>}
  </p>;
}


export function CreditPacks({ source }: { source: string }) {
  const { busy, enabled, checkoutAvailable, buyCredits, appleProducts } = useBilling();
  const apple = isAppleApp();
  return <section id="credit-packs" className="billing-account-card billing-credit-packs">
    <h2>Buy more credits</h2>
    <p>A one-time purchase. Credits never expire, and your plan stays the same.</p>
    <div className="billing-plan-grid billing-plan-grid--paid">
      {[{ key: 'builder', credits: 800, price: '$10.80' }, { key: 'creator', credits: 1500, price: '$22.80' }].map(pack => {
        const price = apple ? appleProducts.find(p => p.id === `ai.brickbuilder.app.credits.${pack.credits}`)?.displayPrice : pack.price;
        return <article key={pack.key} className="billing-plan billing-credit-pack">
          <h3>{pack.credits.toLocaleString()} credits</h3>
          <p className="billing-price"><strong>{price ?? '—'}</strong><span>one time{!apple && ' · USD'}</span></p>
          <button className="billing-plan-button billing-plan-button--primary" disabled={busy || !enabled || !checkoutAvailable || !price}
            onClick={() => void buyCredits(pack.key, source)}>{busy ? 'Opening…' : price ? 'Buy credits' : 'Update app to purchase'}</button>
        </article>;
      })}
    </div>
    <p className="billing-muted">{apple ? 'Priced approximately 20% above the matching monthly plan, using Apple’s available price points.' : 'Priced 20% above the matching monthly plan.'} No subscription or paid-feature access is included.</p>
  </section>;
}
