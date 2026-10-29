import { isAppleApp } from '../services/applePurchases';
import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Coins, CreditCard, ArrowUpRight, RefreshCw } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { useBilling } from '../contexts/BillingContext';
import { billingDate, CreditPacks } from '../components/BillingComponents';
import { PetAvatar } from '../components/PetCompanion';
import { BillingHeader } from './PricingPage';
import { LEGACY_MASTER_PLAN, type BillingAccount } from '../services/billingApi';

const paymentConfirmed = (account: BillingAccount | null) => account?.purchase_confirmed !== undefined
  ? account.purchase_confirmed : Boolean(account?.has_subscription && account.subscription_status === 'active');

export default function BillingPage() {
  const { user } = useAuth();
  const { account, plans, enabled, busy, loading, error, sync, refresh, manage, signIn, openUpgrade, restore } = useBilling();
  const [params, setParams] = useSearchParams();
  const sessionId = params.get('session_id') ?? undefined;
  const [confirmed, setConfirmed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const attempted = useRef('');
  useEffect(() => {
    const key = `${user?.id}:${sessionId ?? 'portal'}`;
    if (!user || attempted.current === key) return;
    attempted.current = key;
    let active = true;
    setConfirming(Boolean(sessionId));
    void sync(sessionId).then(result => {
      if (!active) return;
      setConfirming(false);
      if (sessionId && paymentConfirmed(result)) {
        setConfirmed(true); setParams({}, { replace: true });
        posthog.capture(result?.purchase_confirmed ? 'billing_credit_pack_confirmed' : 'billing_subscription_confirmed', { plan_key: result?.plan_key });
      }
    });
    return () => { active = false; };
  }, [user?.id, sessionId]);
  const apple = account?.subscription_provider === 'apple';
  const plan = plans.find(p => p.key === (apple ? account?.apple_plan : account?.plan_key)) ?? (account?.plan_key === 'master' ? LEGACY_MASTER_PLAN : undefined);
  const labels: Record<string, string> = { referral: 'Account referral reward', purchase: 'Credits purchased', purchase_refund: 'Purchase refunded', welcome: 'Existing credits preserved', monthly: 'Monthly credits', upgrade: 'Plan upgrade', generation: 'AI build or edit', refund: 'Build credit returned' };
  return <div className="billing-page"><BillingHeader /><main className="billing-account-main">
    <div className="billing-account-title"><div><p className="billing-eyebrow">YOUR BUILDING ROOM</p><h1>Credits & billing</h1><p>More ideas ahead. Here’s where you stand.</p></div><PetAvatar state={confirmed ? 'celebrating' : 'idle'} /></div>
    {error && (enabled || account) && <div className="billing-error" role="alert">{error} <button onClick={() => { posthog.capture('billing_retry_clicked'); void refresh(); }}>Try again</button></div>}
    {confirmed && <p className="billing-confirmation" role="status">You’re all set. Your payment is confirmed and your credits are ready.</p>}
    {confirming && <p role="status">Confirming your payment and credits…</p>}
    {!confirming && sessionId && !confirmed && !error && <p role="status">Still waiting for payment confirmation. Your credits will appear after Stripe confirms payment. <button className="billing-text-link" onClick={() => { posthog.capture('billing_confirmation_retry_clicked'); void sync(sessionId).then(result => { if (paymentConfirmed(result)) { setConfirmed(true); setParams({}, { replace: true }); } }); }}>Check again</button></p>}
    {!user ? <section className="billing-account-card"><h2>Your credits live with your account.</h2><p>Sign in to see your balance, receipts, and subscription.</p><button className="billing-primary" onClick={signIn}>Sign in</button></section>
      : !enabled && !account ? <p className="billing-launch-notice" role="status">Monthly plans and credit history are coming soon. Your current building access continues.</p>
      : loading || !account ? <p role="status">{error ? 'Your account details will appear when billing reconnects.' : 'Loading your credits…'}</p> : <>
        <div className="billing-account-grid"><section className="billing-account-card"><div className="billing-card-label"><Coins size={18} /><span>AVAILABLE CREDITS</span></div>
          <p className="billing-big-balance">{account.credits_remaining}<span>ready for your next idea</span></p>
          {!apple && <><div className="billing-balance-row"><span>Monthly credits</span><strong>{account.monthly_remaining} / {account.monthly_credits}</strong></div>
          <progress max={Math.max(1, account.monthly_credits)} value={account.monthly_remaining} aria-label="Monthly credits remaining" /></>}
          <div className="billing-balance-row"><span>Purchased & earned credits · never expire</span><strong>{account.apple_remaining ?? 0}</strong></div>
          <div className="billing-balance-row"><span>Legacy bonus balance · never expires</span><strong>{account.bonus_remaining}</strong></div>
          <p className="billing-muted">{account.bonus_available ?? 0} bonus credits available for Basic builds this month, used after monthly credits. Maximum 5 per month.</p>
          {!apple && <p className="billing-muted">{account.cancel_at_period_end ? 'Paid credits expire' : 'Monthly credits reset'} {billingDate(account.period_end)}.</p>}
          <button className="billing-primary" onClick={() => openUpgrade('billing_balance')}>Explore plans <ArrowUpRight size={16} /></button>
        </section><section className="billing-account-card"><div className="billing-card-label"><CreditCard size={18} /><span>YOUR PLAN</span></div>
          <h2 className="billing-account-plan">{plan?.name ?? 'Free'}<span>{apple ? 'Billed monthly by Apple' : `$${(plan?.monthly_cents ?? 0) / 100} / month`}</span></h2>
          {apple ? <p>Paid features available through {billingDate(account.apple_expires_at!)}. Check renewal or cancellation in Apple subscription settings. Your unused Apple credits never expire.</p> : account.cancel_at_period_end ? <p className="billing-cancel-status">Subscription canceled. Your paid plan continues until {billingDate(account.period_end)}. You won’t be charged again.</p>
            : account.has_subscription ? <p>Renews monthly. Next billing date: {billingDate(account.period_end)}.</p> : <p>300 free credits each month for Basic or All parts builds. No payment method needed.</p>}
          {['past_due', 'unpaid', 'incomplete', 'paused'].includes(account.subscription_status) && <p role="status" className="billing-error">Your payment needs attention. Open billing to update your payment method.</p>}
          {account.has_subscription && <div className="billing-account-actions"><button className="billing-secondary" disabled={busy} onClick={() => void manage('manage')}>{apple ? 'Manage Apple subscription' : 'Manage billing & receipts'} <ArrowUpRight size={16} /></button>
            {!account.cancel_at_period_end && <button className="billing-cancel-button" disabled={busy} onClick={() => void manage('cancel')}>Cancel subscription</button>}</div>}
          <p className="billing-muted">{account.has_subscription ? apple ? 'Payments and cancellation are handled by Apple.' : 'Payments and cancellation are handled securely by Stripe.' : 'Your saved models and bonus credits stay with you.'}</p>
        </section></div>
        <CreditPacks source="billing" />
        <section className="billing-account-card billing-history"><div className="billing-history-heading"><h2>Credit history</h2><button type="button" aria-label="Refresh credit history" onClick={() => { posthog.capture('billing_history_refreshed'); void refresh(); }}><RefreshCw size={17} /></button></div>
          {account.history.length ? <div className="billing-table-wrap"><table><thead><tr><th>Activity</th><th>Date</th><th>Credits</th></tr></thead><tbody>
            {account.history.map(row => <tr key={row.id}><td>{labels[row.kind] ?? 'Credit adjustment'}<span>{row.kind === 'referral' ? 'Referral credits' : row.bucket === 'apple' ? 'Purchased credits' : row.bucket === 'bonus' ? 'Bonus credits' : 'Monthly credits'}</span></td><td>{billingDate(row.created_at)}</td><td className={row.amount > 0 ? 'billing-positive' : ''}>{row.amount > 0 ? '+' : ''}{row.amount}</td></tr>)}
          </tbody></table></div> : <p>Your builds and credit updates will appear here.</p>}
          <p className="billing-muted">Your 30 most recent credit updates.</p></section>
      </>}
    {isAppleApp() && <button className="billing-secondary" disabled={busy} onClick={() => void restore()}>Restore Apple purchases</button>}
    <Link to="/pricing" className="billing-text-link" onClick={() => posthog.capture('billing_compare_plans_clicked')}>Compare all plans & credit details <ArrowUpRight size={15} /></Link>
  </main></div>;
}
