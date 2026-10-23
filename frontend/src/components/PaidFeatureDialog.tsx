import React, { useEffect, useRef } from 'react';
import { LockKeyhole, X, ArrowUpRight } from 'lucide-react';
import posthog from 'posthog-js';
import { useBilling } from '../contexts/BillingContext';
import { PetAvatar } from './PetCompanion';
import { getInstructionKey } from '../utils/instructionLinks';

export function PaidFeatureLock() {
  return <><LockKeyhole size={14} aria-hidden="true" className="paid-feature-lock" /><span className="sr-only"> · Paid plan required</span></>;
}

export function PaidFeatureDialog() {
  const { lockedFeature, closeLockedFeature, getFeatureAccess, openUpgrade, retryAccess } = useBilling();
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
  const featureAccess = getFeatureAccess(lockedFeature.feature, lockedFeature.generationId);
  const title = lockedFeature.feature === 'instructions' ? 'Building instructions' : lockedFeature.feature === 'io' ? 'IO export' : 'LDR export';
  const checking = featureAccess === 'loading';
  const unavailable = featureAccess === 'unavailable';
  return <dialog ref={dialog} className="billing-dialog billing-feature-dialog" aria-labelledby="paid-feature-title" aria-describedby="paid-feature-description"
    onCancel={event => { event.preventDefault(); closeLockedFeature(); }}>
    <button type="button" className="billing-close" aria-label="Close upgrade notice" onClick={closeLockedFeature}><X size={20} /></button>
    <PetAvatar still />
    <div className="billing-feature-icon"><LockKeyhole size={20} aria-hidden="true" /></div>
    <h2 id="paid-feature-title">{checking ? 'Checking your access…' : unavailable ? 'Couldn’t check your access' : lockedFeature.feature === 'instructions' ? 'Unlock building instructions' : `${title} is a paid feature`}</h2>
    <p id="paid-feature-description">{checking ? 'One moment while we check your access.' : unavailable
      ? 'Please try again to check access to your model exports and instructions.'
      : lockedFeature.feature === 'instructions'
        ? 'Instructions are included with kits you order. Open the link in your order email or sign in to the account you ordered from. Builder and Creator also include instructions for other models.'
        : `${title} is not available on the Free plan. Upgrade to Builder or Creator to unlock LDR/IO downloads and step-by-step instructions.`}</p>
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
export function InstructionsAccessGate({ children, embedded = false, generationId }: { children: React.ReactNode; embedded?: boolean; generationId?: string | null }) {
  const { getFeatureAccess, requireFeature, retryAccess } = useBilling();
  const featureAccess = getFeatureAccess('instructions', generationId);
  const linkFailed = featureAccess === 'unavailable' && Boolean(getInstructionKey(generationId));
  const prompted = useRef<string | null>();
  useEffect(() => {
    if (featureAccess === 'locked' && prompted.current !== (generationId ?? null)) {
      prompted.current = generationId ?? null;
      requireFeature('instructions', embedded ? 'embedded_instructions' : 'instructions_link', generationId);
    }
  }, [featureAccess, requireFeature, embedded, generationId]);
  if (featureAccess === 'allowed') return <>{children}</>;
  return <section className="billing-instructions-locked" aria-label="Building instructions locked">
    <LockKeyhole size={28} aria-hidden="true" />
    <h2>{featureAccess === 'loading' ? 'Checking your access…' : 'Building instructions'}</h2>
    <p>{linkFailed ? 'This instruction link couldn’t be verified. Try the link in your order email or contact support@brickbuilder.ai.' : featureAccess === 'unavailable' ? 'We couldn’t check your access. Please try again.' : 'Instructions are included with kits you order. Open the link in your order email or sign in to the account you ordered from. Builder and Creator also include instructions for other models.'}</p>
    {featureAccess !== 'loading' && <button type="button" className="billing-primary" onClick={() => {
      if (featureAccess === 'unavailable') { posthog.capture('billing_feature_retry_clicked', { feature: 'instructions', source: 'instructions_link' }); void retryAccess(); }
      else requireFeature('instructions', embedded ? 'embedded_instructions' : 'instructions_link', generationId);
    }}>{featureAccess === 'unavailable' ? 'Try again' : 'View upgrade options'}<ArrowUpRight size={16} aria-hidden="true" /></button>}
  </section>;
}
