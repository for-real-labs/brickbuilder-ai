import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from './AuthContext';
import { billingApi, INITIAL_PLANS, openStripe, type BillingAccount, type PlanKey } from '../services/billingApi';

const BillingContext = createContext({
  account: null as BillingAccount | null, plans: INITIAL_PLANS, enabled: false, loading: false,
  busy: false, error: '', upgradeSource: '', loginOpen: false,
  refresh: async () => {}, sync: async (_sessionId?: string) => null as BillingAccount | null,
  openUpgrade: (_source: string) => {}, closeUpgrade: () => {},
  subscribe: async (_key: PlanKey, _source: string) => {},
  manage: async (_action: 'manage' | 'cancel') => {},
  closeLogin: () => {}, signIn: () => {},
});

export function BillingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const identity = useRef(user?.id);
  identity.current = user?.id;
  const [account, setAccount] = useState<BillingAccount | null>(null);
  const [plans, setPlans] = useState(INITIAL_PLANS);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [upgradeSource, setUpgradeSource] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const refresh = useCallback(async () => {
    const owner = user?.id;
    if (!owner) return;
    try {
      const result = await billingApi.account();
      if (identity.current === owner) { setAccount(result); setEnabled(result.enabled); setError(''); }
    } catch { if (identity.current === owner) setError('Could not load your credits. Please refresh to try again.'); }
    finally { if (identity.current === owner) setLoading(false); }
  }, [user?.id]);
  useEffect(() => {
    let active = true;
    billingApi.plans().then(result => { if (active) { setPlans(result.plans); setEnabled(result.enabled); } })
      .catch(() => { if (active) setError('Could not load plans. Please refresh to try again.'); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setAccount(null); setError(''); setLoading(Boolean(user));
    void refresh();
    const update = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', update);
    window.addEventListener('brickbuilder:credits-changed', update);
    const interval = window.setInterval(update, 30000);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', update); window.removeEventListener('brickbuilder:credits-changed', update); };
  }, [refresh]);
  const openUpgrade = useCallback((source: string) => {
    setError(''); setUpgradeSource(source);
    posthog.capture('billing_upgrade_opened', { source, page: window.location.pathname });
  }, []);
  useEffect(() => {
    const exhausted = () => { void refresh(); openUpgrade('credits_exhausted'); };
    window.addEventListener('brickbuilder:credits-required', exhausted);
    return () => window.removeEventListener('brickbuilder:credits-required', exhausted);
  }, [refresh, openUpgrade]);
  const closeUpgrade = () => {
    posthog.capture('billing_upgrade_dismissed', { source: upgradeSource }); setUpgradeSource('');
  };
  const sync = async (sessionId?: string) => {
    const owner = user?.id;
    if (!owner) return null;
    try {
      const result = await billingApi.sync(sessionId);
      if (identity.current === owner) { setAccount(result); setEnabled(result.enabled); setError(''); return result; }
    } catch (e) { if (identity.current === owner) setError(e instanceof Error ? e.message : 'Could not refresh billing.'); }
    return null;
  };
  const subscribe = async (key: PlanKey, source: string) => {
    posthog.capture('billing_plan_selected', { plan_key: key, source });
    if (!user) { setUpgradeSource(''); setLoginOpen(true); return; }
    if (key === 'free' || busy) return;
    setBusy(true); setError('');
    try {
      const { url } = await billingApi.checkout(key);
      posthog.capture('billing_checkout_started', { plan_key: key, source }); openStripe(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open checkout. Please try again.');
      posthog.capture('billing_checkout_failed', { plan_key: key, source });
    } finally { setBusy(false); }
  };
  const manage = async (action: 'manage' | 'cancel') => {
    if (busy) return;
    posthog.capture(action === 'cancel' ? 'billing_cancel_clicked' : 'billing_portal_clicked', { source: 'billing' });
    setBusy(true); setError('');
    try { openStripe((await billingApi.portal(action)).url); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open billing. Please try again.'); }
    finally { setBusy(false); }
  };
  return <BillingContext.Provider value={{ account, plans, enabled, loading, busy, error, upgradeSource, loginOpen,
    refresh, sync, openUpgrade, closeUpgrade, subscribe, manage,
    closeLogin: () => setLoginOpen(false), signIn: () => { posthog.capture('billing_sign_in_clicked'); setLoginOpen(true); },
  }}>{children}</BillingContext.Provider>;
}
export const useBilling = () => useContext(BillingContext);
