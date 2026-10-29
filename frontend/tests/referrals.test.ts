import { beforeEach, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/supabase', () => ({ supabase: { rpc } }));
const referrer = '11111111-1111-4111-8111-111111111111';
const visit = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
  vi.resetModules(); rpc.mockReset(); localStorage.clear(); window.history.replaceState({}, '', '/');
});
const load = () => import('../src/services/referrals');
it('captures a server receipt once and carries it into account creation after navigation', async () => {
  window.history.replaceState({}, '', `/?ref=${referrer}`);
  rpc.mockResolvedValue({ data: visit, error: null });
  const service = await load();
  await Promise.all([service.captureReferralLink(), service.captureReferralLink()]);
  window.history.replaceState({}, '', '/login');
  expect(await service.referralSignupMetadata()).toEqual({ referral_visit: visit });
  expect(rpc).toHaveBeenCalledExactlyOnceWith('begin_referral_visit', { p_referrer: referrer });
  vi.resetModules();
  expect(await (await load()).referralSignupMetadata()).toEqual({ referral_visit: visit });
});
it('does not create attribution for guest or invalid links', async () => {
  const service = await load();
  expect(await service.referralSignupMetadata()).toEqual({});
  window.history.replaceState({}, '', '/?ref=not-a-user');
  await service.captureReferralLink();
  expect(rpc).not.toHaveBeenCalled();
});
it('retains attribution through a failed OAuth claim and clears it on server completion', async () => {
  localStorage.setItem('brickbuilder:referral-visit', JSON.stringify({ id: visit, expires: Date.now()+10000 }));
  const service = await load();
  rpc.mockResolvedValueOnce({ error: new Error('Network') });
  await service.claimPendingReferral();
  expect(await service.referralSignupMetadata()).toEqual({ referral_visit: visit });
  rpc.mockResolvedValueOnce({ error: null, data: true });
  await service.claimPendingReferral();
  expect(rpc).toHaveBeenLastCalledWith('claim_account_referral', { p_visit: visit });
  expect(await service.referralSignupMetadata()).toEqual({});
});
it('rejects expired or malformed stored receipts and survives network errors', async () => {
  localStorage.setItem('brickbuilder:referral-visit', JSON.stringify({ id: visit, expires: 0 }));
  const service = await load();
  expect(await service.referralSignupMetadata()).toEqual({});
  window.history.replaceState({}, '', `/?ref=${referrer}`);
  rpc.mockRejectedValue(new Error('Offline'));
  expect(await service.referralSignupMetadata()).toEqual({});
  rpc.mockResolvedValue({ data: 'invalid', error: null });
  expect(await service.referralSignupMetadata()).toEqual({});
});
it('preserves first-touch attribution when a second sender link is opened', async () => {
  localStorage.setItem('brickbuilder:referral-visit', JSON.stringify({ id: visit, expires: Date.now()+10000 }));
  window.history.replaceState({}, '', `/?ref=${referrer}`);
  expect(await (await load()).referralSignupMetadata()).toEqual({ referral_visit: visit });
  expect(rpc).not.toHaveBeenCalled();
});
