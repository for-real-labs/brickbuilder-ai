import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ metadata: vi.fn(), claim: vi.fn(), signup: vi.fn(), otp: vi.fn(), google: vi.fn(), session: vi.fn(), callback: null as null | ((event: string, session: unknown) => void) }));
vi.mock('../src/services/referrals', () => ({ referralSignupMetadata: mocks.metadata, claimPendingReferral: mocks.claim }));
vi.mock('../src/lib/supabase', () => ({ isSupabaseConfigured: true, supabase: {
  auth: { getSession: mocks.session, onAuthStateChange: (callback: typeof mocks.callback) => { mocks.callback = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; }, signUp: mocks.signup, signInWithOtp: mocks.otp, signInWithOAuth: mocks.google },
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: {}, error: null }) }) }) }),
} }));
import { AuthProvider, useAuth } from '../src/contexts/AuthContext';
let auth: ReturnType<typeof useAuth>;
function Probe() { auth = useAuth(); return null; }
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ data: { session: null } });
  mocks.metadata.mockResolvedValue({ referral_visit: 'receipt' });
  for (const action of [mocks.signup, mocks.otp, mocks.google]) action.mockResolvedValue({ error: null });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<AuthProvider><Probe /></AuthProvider>));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('passes referral attribution to password and OTP account creation', async () => {
  await auth.signUp('new@example.test', 'password');
  await auth.signInWithOtp('new@example.test');
  for (const action of [mocks.signup, mocks.otp]) expect(action.mock.calls[0][0].options.data).toEqual({ referral_visit: 'receipt' });
});
it('waits for attribution before leaving for Google', async () => {
  let finish!: (value: {}) => void;
  mocks.metadata.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const result = auth.signInWithGoogle();
  expect(mocks.google).not.toHaveBeenCalled();
  finish({}); await result;
  expect(mocks.google).toHaveBeenCalledOnce();
});
it('claims only after a confirmed non-guest session is available', async () => {
  const user = { id: 'new-user', email_confirmed_at: null, is_anonymous: false };
  await act(async () => mocks.callback!('SIGNED_IN', { user }));
  expect(mocks.claim).not.toHaveBeenCalled();
  await act(async () => mocks.callback!('USER_UPDATED', { user: { ...user, email_confirmed_at: '2026-10-29', is_anonymous: true } }));
  expect(mocks.claim).not.toHaveBeenCalled();
  await act(async () => mocks.callback!('SIGNED_IN', { user: { ...user, id: 'real-user', email_confirmed_at: '2026-10-29' } }));
  expect(mocks.claim).toHaveBeenCalledOnce();
});
