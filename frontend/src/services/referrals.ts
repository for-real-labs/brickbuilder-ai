import { supabase } from '../lib/supabase';

const storageKey = 'brickbuilder:referral-visit';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lifetime = 30 * 24 * 60 * 60 * 1000;
type Receipt = { id: string; expires: number };
let memory: Receipt | undefined;
let pending: Promise<void> | undefined;

function receipt(): Receipt | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (value && uuid.test(value.id) && Number.isFinite(value.expires) && value.expires > Date.now()) return value;
  } catch { /* Storage can be disabled; preserve attribution in this tab. */ }
  return memory && memory.expires > Date.now() ? memory : undefined;
}

/** First valid shared link wins for 30 days; later navigation preserves it. */
export function captureReferralLink(): Promise<void> {
  if (pending) return pending;
  const referrer = new URLSearchParams(window.location.search).get('ref') || '';
  if (!uuid.test(referrer) || receipt()) return Promise.resolve();
  pending = (async () => {
    try {
      const { data, error } = await supabase.rpc('begin_referral_visit', { p_referrer: referrer });
      if (error || typeof data !== 'string' || !uuid.test(data)) return;
      memory = { id: data, expires: Date.now() + lifetime };
      try { localStorage.setItem(storageKey, JSON.stringify(memory)); } catch { /* Use memory. */ }
    } catch { /* A referral outage must not block viewing a shared model. */ }
  })().finally(() => { pending = undefined; });
  return pending;
}

export async function referralSignupMetadata(): Promise<{ referral_visit?: string }> {
  await captureReferralLink();
  const value = receipt();
  return value ? { referral_visit: value.id } : {};
}

/** OAuth returns to this browser; the server checks account age and confirmation. */
export async function claimPendingReferral(): Promise<void> {
  await pending;
  const value = receipt();
  if (!value) return;
  try {
    const { error } = await supabase.rpc('claim_account_referral', { p_visit: value.id });
    if (error) return; // Retain the receipt for a retry after a network failure.
    memory = undefined;
    try { localStorage.removeItem(storageKey); } catch { /* Storage can be disabled. */ }
  } catch { /* Auth must continue even if attribution needs a later retry. */ }
}
