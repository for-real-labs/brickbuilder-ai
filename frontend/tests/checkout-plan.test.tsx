import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import CheckoutPlan from '../src/pages/CheckoutPlan';
import { INITIAL_PLANS } from '../src/services/billingApi';

const mocks = vi.hoisted(() => ({
  user: null as null | { id: string; email: string }, loading: false, account: null as null | { has_subscription: boolean },
  checkout: vi.fn(), signIn: vi.fn(), google: vi.fn(), payment: vi.fn(),
}));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user, loading: mocks.loading, signIn: mocks.signIn, signInWithGoogle: mocks.google }) }));
vi.mock('../src/contexts/BillingContext', () => ({ useBilling: () => ({ plans: INITIAL_PLANS, enabled: true, checkoutAvailable: true, loading: false, account: mocks.account }) }));
vi.mock('../src/services/billingApi', async original => ({ ...await original<any>(), billingApi: { planCheckout: mocks.checkout } }));
vi.mock('../src/components/checkout/CheckoutPayment', () => ({ CheckoutPayment: (props: any) => { mocks.payment(props); return <div>Embedded payment for {props.email}</div>; } }));
vi.mock('../src/components/PetCompanion', () => ({ PetAvatar: () => <span /> }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/PasswordRecovery', () => ({ PasswordRecovery: () => null }));
vi.mock('../src/components/SignupCodeVerification', () => ({ SignupCodeVerification: () => <div>Verify your email here</div> }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (path = '/checkout-plan?plan=creator') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><CheckoutPlan /></MemoryRouter>));
const click = async (label: string) => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === label)!.click());
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = null; mocks.loading = false; mocks.account = null;
  mocks.checkout.mockResolvedValue({ session_id: 'cs_plan', client_secret: 'plan_secret' });
  mocks.signIn.mockResolvedValue({ error: null, confirmationRequired: true });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('keeps guest profile creation inline with the selected plan and requests no shipping or name', async () => {
  await render();
  expect(container.textContent).toContain('Creator');
  expect(container.textContent).toContain('$19.99');
  expect([...container.querySelectorAll('input')].map(input => input.type)).toEqual(['email', 'password']);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.checkout).not.toHaveBeenCalled();
  const inputs = container.querySelectorAll('input');
  await act(async () => {
    for (const [index, value] of ['new@example.test', 'a-test-password'].entries()) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.signIn).toHaveBeenCalledWith('new@example.test', 'a-test-password', '/checkout-plan?plan=creator');
  expect(container.textContent).toContain('Verify your email here');
  expect(mocks.checkout).not.toHaveBeenCalled();
});

it('returns Google sign-in to the same selected plan', async () => {
  mocks.google.mockResolvedValue({ error: null });
  await render('/checkout-plan?plan=builder');
  await click('Continue with Google');
  expect(mocks.google).toHaveBeenCalledWith('/checkout-plan?plan=builder');
});

it('opens embedded payment only after authentication, with email and no delivery fields', async () => {
  await render();
  mocks.user = { id: 'user-1', email: 'builder@example.test' };
  await render();
  expect(mocks.checkout).toHaveBeenCalledWith('creator');
  const props = mocks.payment.mock.lastCall![0];
  expect(props.subscriptionPlan).toBe('creator');
  expect(props.email).toBe('builder@example.test');
  expect(props.session.client_secret).toBe('plan_secret');
  expect(props).not.toHaveProperty('details');
  expect(props).not.toHaveProperty('country');
});

it('offers retry in the same checkout after an initialization failure', async () => {
  mocks.user = { id: 'user-1', email: 'builder@example.test' };
  mocks.checkout.mockRejectedValueOnce(new Error('Please retry.'));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please retry.');
  await click('Try again');
  expect(container.textContent).toContain('Embedded payment');
});

it('never attaches a previous account’s checkout after logout', async () => {
  let finish!: (value: any) => void;
  mocks.checkout.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  mocks.user = { id: 'user-1', email: 'builder@example.test' };
  await render();
  mocks.user = null;
  await render();
  await act(async () => finish({ session_id: 'cs_old', client_secret: 'old_secret' }));
  expect(mocks.payment).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Create your profile');
});

it('does not start a second subscription for an existing subscriber', async () => {
  mocks.user = { id: 'user-1', email: 'builder@example.test' };
  mocks.account = { has_subscription: true };
  await render();
  expect(container.textContent).toContain('Manage your plan in Billing');
  expect(mocks.checkout).not.toHaveBeenCalled();
});

it('does not accept a plan or price supplied in an unrecognized plan parameter', async () => {
  mocks.user = { id: 'user-1', email: 'builder@example.test' };
  await render('/checkout-plan?plan=free&price=1');
  expect(container.textContent).toContain('Choose your plan');
  expect(mocks.checkout).not.toHaveBeenCalled();
});
