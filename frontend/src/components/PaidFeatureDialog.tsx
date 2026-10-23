import React, { useEffect, useRef } from 'react';
import { LockKeyhole, X, ArrowUpRight } from 'lucide-react';
import posthog from 'posthog-js';
import { useBilling } from '../contexts/BillingContext';
import { PetAvatar } from './PetCompanion';

export function PaidFeatureLock() {
  return <><LockKeyhole size={14} aria-hidden="true" className="paid-feature-lock" /><span className="sr-only"> · Paid plan required</span></>;
}

export function PaidFeatureDialog() {
  const { lockedFeature, closeLockedFeature, featureAccess, openUpgrade, retryAccess } = useBilling();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!lockedFeature) return;
    const element = dialog.current;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      if (element?.open) element.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [lockedFeature]);
  if (!lockedFeature) return null;
  const title = lockedFeature.feature === 'instructions' ? 'Building instructions' : lockedFeature.feature === 'io' ? 'IO export' : 'LDR export';
  const checking = featureAccess === 'loading';
  const unavailable = featureAccess === 'unavailable';
  return <dialog ref={dialog} className="billing-dialog billing-feature-dialog" aria-labelledby="paid-feature-title" aria-describedby="paid-feature-description"
    onCancel={event => { event.preventDefault(); closeLockedFeature(); }}>
    <button type="button" className="billing-close" aria-label="Close upgrade notice" onClick={closeLockedFeature}><X size={20} /></button>
    <PetAvatar still />
    <div className="billing-feature-icon"><LockKeyhole size={20} aria-hidden="true" /></div>
    <h2 id="paid-feature-title">{checking ? 'Checking your plan…' : unavailable ? 'Couldn’t check your plan' : `${title} ${lockedFeature.feature === 'instructions' ? 'are' : 'is'} a paid feature`}</h2>
    <p id="paid-feature-description">{checking ? 'One moment while we check your access.' : unavailable
      ? 'Please try again to check access to your model exports and instructions.'
      : `${title} ${lockedFeature.feature === 'instructions' ? 'are' : 'is'} not available on the Free plan. Upgrade to Builder or Creator to unlock LDR/IO downloads and step-by-step instructions.`}</p>
    <div className="billing-feature-actions">
      {!checking && <button type="button" className="billing-primary" onClick={() => {
        if (unavailable) { posthog.capture('billing_feature_retry_clicked', lockedFeature); void retryAccess(); }
        else { posthog.capture('billing_feature_upgrade_clicked', lockedFeature); openUpgrade(`locked_${lockedFeature.feature}`); }
      }}>{unavailable ? 'Try again' : 'Upgrade plan'}<ArrowUpRight size={16} aria-hidden="true" /></button>}
      <button type="button" className="billing-secondary" onClick={closeLockedFeature}>Not now</button>
    </div>
  </dialog>;
}

/** Never mount an instruction viewer until the current account can use it. */
export function InstructionsAccessGate({ children, embedded = false }: { children: React.ReactNode; embedded?: boolean }) {
  const { featureAccess, requireFeature, retryAccess } = useBilling();
  const prompted = useRef(false);
  useEffect(() => {
    if (featureAccess === 'locked' && !prompted.current) {
      prompted.current = true;
      requireFeature('instructions', embedded ? 'embedded_instructions' : 'instructions_link');
    }
  }, [featureAccess, requireFeature, embedded]);
  if (featureAccess === 'allowed') return <>{children}</>;
  return <section className="billing-instructions-locked" aria-label="Building instructions locked">
    <LockKeyhole size={28} aria-hidden="true" />
    <h2>{featureAccess === 'loading' ? 'Checking your plan…' : 'Building instructions'}</h2>
    <p>{featureAccess === 'unavailable' ? 'We couldn’t check your plan. Please try again.' : 'Unlock step-by-step instructions with Builder or Creator.'}</p>
    {featureAccess !== 'loading' && <button type="button" className="billing-primary" onClick={() => {
      if (featureAccess === 'unavailable') { posthog.capture('billing_feature_retry_clicked', { feature: 'instructions', source: 'instructions_link' }); void retryAccess(); }
      else requireFeature('instructions', embedded ? 'embedded_instructions' : 'instructions_link');
    }}>{featureAccess === 'unavailable' ? 'Try again' : 'View upgrade options'}<ArrowUpRight size={16} aria-hidden="true" /></button>}
  </section>;
}
