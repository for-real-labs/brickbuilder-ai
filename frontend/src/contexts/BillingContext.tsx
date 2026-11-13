import { GENERATION_SUBSCRIPTION_EVENT, GENERATION_SUBSCRIPTION_SOURCE } from '../utils/generationSubscription';
import { APPLE_EVENT, appleRequest, appleProduct, isAppleApp, hasApplePurchases, type AppleProduct } from '../services/applePurchases';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { billingApi, INITIAL_PLANS, openStripe, type BillingAccount, type PlanKey, type PaidFeature, type FeatureAccess } from '../services/billingApi';
const BillingContext = createContext({
  account: null as BillingAccount | null, plans: INITIAL_PLANS, enabled: false, checkoutAvailable: false, loading: false,
  appleProducts: [] as AppleProduct[], restore: async () => {},
  busy: false, error: '', upgradeSource: '', loginOpen: false,
  featureAccess: 'loading' as FeatureAccess,
  getFeatureAccess: (feature: PaidFeature, _generationId?: string | null): FeatureAccess => (feature === 'instructions' || feature === 'ldraw') ? 'allowed' : 'loading',
  lockedFeature: null as { feature: PaidFeature; source: string; generationId?: string | null } | null,
  requireFeature: (feature: PaidFeature, _source: string, _generationId?: string | null): boolean => (feature === 'instructions' || feature === 'ldraw'),
  closeLockedFeature: () => {}, retryAccess: async () => {},
  redeemPromo: async (_code: string): Promise<BillingAccount> => { throw new Error('Billing unavailable'); },
  refresh: async () => {}, sync: async (_sessionId?: string) => null as BillingAccount | null,
  openUpgrade: (_source: string) => {}, closeUpgrade: () => {},
  buyCredits: async (_amount: number | string, _source: string) => {},
  subscribe: async (_key: PlanKey, _source: string) => {},
  manage: async (_action: 'manage' | 'cancel') => {},
  closeLogin: () => {}, signIn: () => {},
});

export function BillingProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const [appleProducts, setAppleProducts] = useState<AppleProduct[]>([]);
  const [appleReady, setAppleReady] = useState(false);
  const [account, setAccount] = useState<BillingAccount | null>(null);
  const [accountOwner, setAccountOwner] = useState<string>();
  const [plansStatus, setPlansStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [plans, setPlans] = useState(INITIAL_PLANS);
  const [enabled, setEnabled] = useState(false);
  const [checkoutAvailable, setCheckoutAvailable] = useState(false);
  const [loading, setLoading] = useState(Boolean(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [upgradeSource, setUpgradeSource] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [lockedFeature, setLockedFeature] = useState<{ feature: PaidFeature; source: string; generationId?: string | null } | null>(null);
  const refresh = useCallback(async () => {
    const owner = user?.id;
    if (!owner) return;
    try {
      const result = await billingApi.account();
      if (identity.current === owner) { setAccount(result); setAccountOwner(owner); setEnabled(result.enabled); setCheckoutAvailable(result.checkout_available ?? result.enabled); setError(''); }
    } catch { if (identity.current === owner) { setAccount(null); setAccountOwner(undefined); setError('Could not load your credits. Please refresh to try again.'); } }
    finally { if (identity.current === owner) setLoading(false); }
  }, [user?.id]);
  const refreshPlans = useCallback(async () => {
    try {
      const result = await billingApi.plans();
      setAppleReady(Boolean(result.apple_ready));
      setPlans(result.plans.filter(plan => plan.key !== 'master' && plan.key !== 'free'));
      setEnabled(result.enabled); setCheckoutAvailable(result.checkout_available ?? result.enabled);
      setPlansStatus(result.ready ? 'ready' : 'error');
    } catch { setEnabled(false); setCheckoutAvailable(false); setPlansStatus('error'); }
  }, []);
  useEffect(() => {
    const update = () => { if (!document.hidden) void refreshPlans(); };
    update();
    window.addEventListener('focus', update);
    const interval = window.setInterval(update, 60000);
    return () => { window.removeEventListener('focus', update); window.clearInterval(interval); };
  }, [refreshPlans]);
  useEffect(() => {
    setAccount(null); setAccountOwner(undefined); setError(''); setLoading(Boolean(user));
    void refresh();
    const update = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', update);
    window.addEventListener('brickbuilder:credits-changed', update);
    const interval = window.setInterval(update, 30000);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', update); window.removeEventListener('brickbuilder:credits-changed', update); };
  }, [refresh]);
  const refreshProducts = useCallback(async () => {
    if (!hasApplePurchases()) return;
    try { setAppleProducts(await appleRequest<AppleProduct[]>('products')); }
    catch { setAppleProducts([]); setError('Could not load Apple prices. Retry the Apple connection or restore an existing purchase.'); }
  }, []);
  useEffect(() => { void refreshProducts(); }, [refreshProducts]);
  const processing = useRef(new Set<string>());
  const confirmApple = useCallback(async (transaction: string) => {
    const owner = user?.id;
    if (!owner || !/^\d{1,40}$/.test(transaction) || processing.current.has(transaction)) return;
    processing.current.add(transaction);
    try {
      await billingApi.appleSync(transaction);
      if (identity.current !== owner) return;
      // Credits are already committed by the server. A StoreKit acknowledgement
      // failure must not turn a verified restore into a payment failure. Leave
      // the native transaction queued for the next reconciliation attempt.
      try {
        await appleRequest('finish', { transaction });
      } catch {
        posthog.capture('billing_apple_finish_deferred', { provider: 'apple' });
      }
      if (identity.current !== owner) return;
      await refresh();
      setUpgradeSource('');
      posthog.capture('billing_subscription_confirmed', { provider: 'apple' });
    } finally { processing.current.delete(transaction); }
  }, [user?.id, refresh]);
  useEffect(() => {
    if (!user || !hasApplePurchases()) return;
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.transaction) void confirmApple(detail.transaction).catch(e => setError(e.message));
      if (detail?.error && !detail.id) setError(detail.error);
    };
    window.addEventListener(APPLE_EVENT, listener);
    void appleRequest<string[]>('pending').then(async ids => {
      for (const id of ids) await confirmApple(id);
    }).catch(() => {});
    return () => window.removeEventListener(APPLE_EVENT, listener);
  }, [user?.id, confirmApple]);
  const restore = async () => {
    posthog.capture('billing_restore_clicked', { provider: 'apple' });
    if (!user) { setLoginOpen(true); return; }
    setBusy(true); setError('');
    try {
      const ids = await appleRequest<string[]>('restore');
      for (const id of ids) await confirmApple(id);
      if (!ids.length) setError('No Apple subscriptions were found for this Apple account.');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not restore purchases.'); }
    finally { setBusy(false); }
  };
  const featureAccess: FeatureAccess = plansStatus === 'loading' ? 'loading' : plansStatus === 'error' ? 'unavailable'
    : !enabled ? 'allowed' : !user ? 'locked' : accountOwner !== user.id || !account ? loading ? 'loading' : 'unavailable'
    : account.paid_features && new Date(account.subscription_provider === 'apple' ? account.apple_expires_at ?? account.period_end : account.period_end).getTime() > Date.now() ? 'allowed' : 'locked';
  const getFeatureAccess = useCallback((feature: PaidFeature, _generationId?: string | null): FeatureAccess => {
    return (feature === 'instructions' || feature === 'ldraw') ? 'allowed' : featureAccess;
  }, [featureAccess]);
  const requireFeature = useCallback((feature: PaidFeature, source: string, generationId?: string | null) => {
    const access = getFeatureAccess(feature, generationId);
    if (access === 'allowed') return true;
    setLockedFeature({ feature, source, ...(generationId ? { generationId } : {}) });
    posthog.capture('billing_feature_blocked', { feature, source, access });
    return false;
  }, [getFeatureAccess]);
  const closeLockedFeature = () => {
    if (lockedFeature) posthog.capture('billing_feature_dismissed', lockedFeature);
    setLockedFeature(null);
  };
  useEffect(() => {
    if (lockedFeature && getFeatureAccess(lockedFeature.feature, lockedFeature.generationId) === 'allowed') setLockedFeature(null);
  }, [getFeatureAccess, lockedFeature]);
  const openUpgrade = useCallback((source: string) => {
    setError(''); setLockedFeature(null); setUpgradeSource(source);
    posthog.capture('billing_upgrade_opened', { source, page: window.location.pathname });
  }, []);
  useEffect(() => {
    const exhausted = () => { void refresh(); };
    const subscription = () => openUpgrade(GENERATION_SUBSCRIPTION_SOURCE);
    window.addEventListener('brickbuilder:credits-required', exhausted);
    window.addEventListener(GENERATION_SUBSCRIPTION_EVENT, subscription);
    return () => {
      window.removeEventListener('brickbuilder:credits-required', exhausted);
      window.removeEventListener(GENERATION_SUBSCRIPTION_EVENT, subscription);
    };
  }, [refresh, openUpgrade]);
  const closeUpgrade = () => {
    posthog.capture('billing_upgrade_dismissed', { source: upgradeSource }); setUpgradeSource('');
  };
  const sync = async (sessionId?: string) => {
    const owner = user?.id;
    if (!owner) return null;
    try {
      const result = await billingApi.sync(sessionId);
      if (identity.current === owner) { setAccount(result); setAccountOwner(owner); setEnabled(result.enabled); setCheckoutAvailable(result.checkout_available ?? result.enabled); setError(''); return result; }
    } catch (e) { if (identity.current === owner) setError(e instanceof Error ? e.message : 'Could not refresh billing.'); }
    return null;
  };
  const redeemPromo = async (code: string) => {
    const owner = user?.id;
    if (!owner) throw new Error('Sign in to apply a promo.');
    const result = await billingApi.redeemPromo(code);
    if (identity.current !== owner) throw new Error('Your account changed. Please try again.');
    setAccount(result.account); setAccountOwner(owner); setEnabled(result.account.enabled);
    setCheckoutAvailable(result.account.checkout_available ?? result.account.enabled); setError('');
    return result.account;
  };
  const subscribe = async (key: PlanKey, source: string) => {
    posthog.capture('billing_plan_selected', { plan_key: key, source });
    if (key === 'free' || key === 'master' || busy) return;
    if (!isAppleApp()) { setUpgradeSource(''); navigate(`/checkout-plan?plan=${key}`); return; }
    if (!user) { setUpgradeSource(''); setLoginOpen(true); return; }
    setBusy(true); setError('');
    try {
      if (isAppleApp()) {
        if (!hasApplePurchases()) throw new Error('Update BrickBuilder from the App Store to subscribe.');
        const prepared = await billingApi.applePrepare();
        if (identity.current !== user.id) return;
        await appleRequest('buy', { product: appleProduct(key), accountToken: prepared.app_account_token });
        posthog.capture('billing_checkout_started', { plan_key: key, source, provider: 'apple' });
        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open checkout. Please try again.');
      posthog.capture('billing_checkout_failed', { plan_key: key, source });
    } finally { setBusy(false); }
  };
  const buyCredits = async (amount: number | string, source: string) => {
    posthog.capture('billing_credit_pack_selected', { amount_cents: typeof amount === 'number' ? amount : undefined, source });
    if (!user) { setUpgradeSource(''); setLoginOpen(true); return; }
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (isAppleApp()) {
        const product = `ai.brickbuilder.app.credits.${amount === 'builder' ? 800 : 1500}`;
        if (!appleProducts.some(p => p.id === product)) throw new Error('Update BrickBuilder from the App Store to buy additional credits.');
        const prepared = await billingApi.appleCreditPrepare();
        if (identity.current !== user.id) return;
        await appleRequest('buy', { product, accountToken: prepared.app_account_token });
      } else {
        setUpgradeSource('');
        navigate(`/checkout-credits?amount=${Number(amount)}`);
      }
      posthog.capture('billing_credit_pack_checkout_started', { amount_cents: typeof amount === 'number' ? amount : undefined, source, provider: isAppleApp() ? 'apple' : 'stripe' });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not purchase credits. Please try again.');
      posthog.capture('billing_credit_pack_checkout_failed', { amount_cents: typeof amount === 'number' ? amount : undefined, source });
    } finally { setBusy(false); }
  };
  const manage = async (action: 'manage' | 'cancel') => {
    if (busy) return;
    posthog.capture(action === 'cancel' ? 'billing_cancel_clicked' : 'billing_portal_clicked', { source: 'billing' });
    setBusy(true); setError('');
    try {
      if (account?.subscription_provider === 'apple') {
        if (isAppleApp()) { await appleRequest('manage'); await refresh(); }
        else window.location.assign('https://apps.apple.com/account/subscriptions');
      } else if (isAppleApp()) throw new Error('Your subscription was purchased on the web. Manage it from your account on the BrickBuilder website.');
      else openStripe((await billingApi.portal(action)).url);
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open billing. Please try again.'); }
    finally { setBusy(false); }
  };
  return <BillingContext.Provider value={{ account, plans, enabled, appleProducts, restore, checkoutAvailable: checkoutAvailable && (!isAppleApp() || (appleReady && hasApplePurchases() && appleProducts.length > 0)), loading, busy, error, upgradeSource, loginOpen,
    featureAccess, getFeatureAccess, lockedFeature, requireFeature, closeLockedFeature,
    retryAccess: async () => { await Promise.all([refreshPlans(), refresh(), refreshProducts()]); },
    redeemPromo, refresh, sync, openUpgrade, closeUpgrade, subscribe, buyCredits, manage,
    closeLogin: () => setLoginOpen(false), signIn: () => { posthog.capture('billing_sign_in_clicked'); setLoginOpen(true); },
  }}>{children}</BillingContext.Provider>;
}
export const useBilling = () => useContext(BillingContext);
