import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import CheckoutCredits from '../src/pages/CheckoutCredits';

const mocks = vi.hoisted(() => ({ user: { id: 'one', email: 'buyer@example.test' } as {id:string;email:string}|null,
  account: { has_subscription: true, paid_features: true, plan_key: 'builder' }, checkout: vi.fn(), payment: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user, loading: false }) }));
vi.mock('../src/contexts/BillingContext', () => ({ useBilling: () => ({ account: mocks.account, loading: false, enabled: true, checkoutAvailable: true }) }));
vi.mock('../src/services/billingApi', () => ({ billingApi: { creditCheckout: mocks.checkout } }));
vi.mock('../src/components/checkout/CheckoutPayment', () => ({ CheckoutPayment: (props: any) => { mocks.payment(props); return <div>Embedded credits payment</div>; } }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = async (path = '/checkout-credits?amount=1000') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><CheckoutCredits /></MemoryRouter>));
beforeEach(() => {
  vi.clearAllMocks(); mocks.user = { id: 'one', email: 'buyer@example.test' }; mocks.account.has_subscription = true;
  mocks.checkout.mockResolvedValue({ session_id: 'cs_credit', client_secret: 'secret' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it('uses shared embedded payment with a one-time quote and no delivery', async () => {
  await render();
  expect(mocks.checkout).toHaveBeenCalledWith(1000);
  expect(container.textContent).toContain('753 credits');
  expect(container.textContent).toContain('$10.00');
  const props = mocks.payment.mock.lastCall![0];
  expect(props.creditPurchase).toBe(true);
  expect(props.email).toBe('buyer@example.test');
  expect(props).not.toHaveProperty('details');
  expect(props).not.toHaveProperty('subscriptionPlan');
});
it.each(['0','NaN','1000.5','1000000'])('rejects invalid amount %s without opening payment', async amount => {
  await render(`/checkout-credits?amount=${amount}`);
  expect(mocks.checkout).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});
it('requires a subscription', async () => {
  mocks.account.has_subscription = false;
  await render();
  expect(mocks.checkout).not.toHaveBeenCalled();
});
it('discards a pending payment session when the account changes', async () => {
  let finish!: (value: unknown) => void;
  mocks.checkout.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render();
  mocks.user = null;
  await render();
  await act(async () => finish({ session_id: 'cs_old', client_secret: 'secret' }));
  expect(mocks.payment).not.toHaveBeenCalled();
});
