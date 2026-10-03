import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import OrderKit from '../src/pages/OrderKit';
import { CheckoutPayment } from '../src/components/checkout/CheckoutPayment';
import { getOrderPricing, getShippingContact } from '../src/utils/orderCheckout';
import { CreateCheckoutSessionApiService } from '../src/services/createCheckoutSessionApi';
import { GetPriceApiService } from '../src/services/getPriceApi';
import posthog from 'posthog-js';

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), mount: vi.fn(), destroy: vi.fn(), loadActions: vi.fn(), loadStripe: vi.fn(), initCheckout: vi.fn(), walletUpdate: vi.fn(), walletEvents: {} as Record<string, (event?: unknown) => void>, paymentEvents: {} as Record<string, (event?: unknown) => void> }));
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: mocks.loadStripe }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ showModelControls }: { showModelControls?: boolean }) => <div data-testid="model-preview" data-controls={String(showModelControls)}>Model preview</div> }));
vi.mock('../src/services/ldrToMpdApi', () => ({ LdrToMpdApiService: { convertLdrToMpd: async () => ({ mpd_content: '0 Frog' }) } }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/services/getGenerationApi', () => ({ GetGenerationApiService: { getGeneration: async () => ({ name: 'Frog', status: 'completed', ldr_content: '0 Frog' }) } }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'auth-token' } } }) } } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const quote = { total_price: 50, total_weight: 0.1, total_parts: 240 };
const details = { email: 'test@example.com', name: 'Test Builder', line1: '123 Test Street', line2: '', city: 'Chicago', region: 'IL', postalCode: '60601' };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', 'pk_test_example');
  mocks.confirm.mockReset(); mocks.destroy.mockReset(); mocks.mount.mockReset();
  mocks.paymentEvents = {}; mocks.walletEvents = {}; mocks.walletUpdate.mockReset();
  mocks.mount.mockImplementation(() => mocks.paymentEvents.ready?.());
  mocks.loadActions.mockResolvedValue({ type: 'success', actions: { confirm: mocks.confirm } });
  mocks.initCheckout.mockReset();
  mocks.initCheckout.mockImplementation(() => ({ loadActions: mocks.loadActions, createPaymentElement: () => ({
    on: (event: string, callback: (event?: unknown) => void) => { mocks.paymentEvents[event] = callback; }, mount: mocks.mount, destroy: mocks.destroy,
  }), createExpressCheckoutElement: () => ({
    on: (event: string, callback: (event?: unknown) => void) => { mocks.walletEvents[event] = callback; },
    mount: () => mocks.walletEvents.ready?.({ availablePaymentMethods: { applePay: true, googlePay: true } }),
    update: mocks.walletUpdate, destroy: vi.fn(),
  }) }));
  mocks.loadStripe.mockResolvedValue({ initCheckout: mocks.initCheckout });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(text))!;
  await act(async () => button.click());
};
const renderOrder = async (state: object = { generation_id: 'g', priceData: quote }) => act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/order', state }]}><OrderKit /></MemoryRouter>));
const fill = (name: string, value: string) => {
  const input = container.querySelector(`input[name="${name}"]`);
  if (!input && name === 'line2' && !value) return;
  if (!input) throw new Error(`Missing field ${name}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const submitContact = () => act(async () => container.querySelector('#checkout-step-1 form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

it('handles absent, invalid, and valid pricing without displaying a fake total', () => {
  expect(getOrderPricing(null)).toBeNull();
  expect(getOrderPricing({ total_price: NaN, total_weight: 0 })).toBeNull();
  expect(getOrderPricing({ total_price: 20, total_weight: -1 })).toBeNull();
  expect(getOrderPricing(quote)).toMatchObject({ partSubtotalCents: 2210, shippingCents: 290, totalCents: 2500 });
});

it('uses a text-only brand link in the checkout header', async () => {
  await renderOrder();
  const brand = container.querySelector('a[aria-label="BrickBuilder home"]')!;
  expect(brand.textContent).toBe('BRICKBUILDER');
  expect(brand.querySelector('svg, img')).toBeNull();
});

it('shows regular line items, a separate discount, and crosses out only the original total', async () => {
  await renderOrder();
  const rows = container.querySelectorAll('.checkout-price-list > div');
  expect(rows[0].querySelector('dd')?.textContent).toBe('$44.20');
  expect(rows[1].querySelector('dd')?.textContent).toBe('$5.80');
  expect(rows[2].textContent).toBe('BrickBuilder Launch Discount−$25.00');
  expect(rows[0].querySelector('s')).toBeNull();
  expect(rows[1].querySelector('s')).toBeNull();
  expect(container.querySelector('.checkout-price-list')?.querySelectorAll('s')).toHaveLength(1);
  expect(container.querySelector('.checkout-total s')?.textContent).toBe('$50.00');
  expect(container.querySelector('.checkout-total')?.textContent).toContain('USD$25.00');
  expect(container.querySelector('.checkout-savings')?.textContent).toBe('You save $25.00');
});

it('keeps support and legal links in the compact checkout footer', async () => {
  await renderOrder();
  const footer = container.querySelector('footer')!;
  expect(footer.querySelector('a[href="mailto:support@brickbuilder.ai"]')).not.toBeNull();
  expect(footer.querySelector('a[href="/privacy"]')).not.toBeNull();
  expect(footer.querySelector('a[href="/terms"]')).not.toBeNull();
});

it('starts with contact details, keeps the preview visible, and has no shipping step or provider branding', async () => {
  await renderOrder();
  expect(container.querySelector('#checkout-step-1')!.hasAttribute('hidden')).toBe(false);
  expect(container.querySelector('section[aria-label="Shipping"]')).toBeNull();
  expect(container.querySelector('nav')?.textContent).toContain('Contact & delivery');
  expect(container.querySelector('nav')?.textContent).not.toContain('Shipping');
  expect(container.textContent).not.toContain('Stripe');
  expect(container.textContent).not.toMatch(/regular kit/i);
  expect(container.querySelector('.checkout-summary-model')?.textContent).toContain('240 pieces');
  expect(container.querySelector('.checkout-summary-benefits')?.textContent).toContain('Estimated delivery: 8–12 business days');
  const preview = container.querySelector('[data-testid="model-preview"]')!;
  expect(preview.getAttribute('data-controls')).toBe('false');
  expect(preview.closest('#checkout-price-breakdown')).toBeNull();
  expect(container.querySelector('.checkout-summary')!.compareDocumentPosition(container.querySelector('.checkout-flow')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => container.querySelector<HTMLButtonElement>('.checkout-summary-toggle')!.click());
  expect(container.querySelector('.checkout-summary-toggle')!.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-testid="model-preview"]')).toBe(preview);
});

it('retains country and optional apartment details when editing after payment', async () => {
  vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret' });
  await renderOrder();
  await click('Add apartment');
  act(() => Object.entries({ ...details, line2: 'Suite 2' }).forEach(([name, value]) => fill(name, value)));
  const country = container.querySelector('select')!;
  await act(async () => { country.value = 'CA'; country.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('Province');
  await submitContact();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to contact and delivery"]')!.click());
  expect(container.querySelector('select')!.value).toBe('CA');
  expect(container.querySelector<HTMLInputElement>('[name="line2"]')!.value).toBe('Suite 2');
  expect(posthog.capture).toHaveBeenCalledWith('order_apartment_field_opened', expect.objectContaining({ generation_id: 'g' }));
});

it('shows a useful empty checkout when no model is selected', async () => {
  await renderOrder({});
  expect(container.textContent).toContain('Your kit starts with a model');
  expect(container.querySelector('a.checkout-primary')?.getAttribute('href')).toBe('/');
});

it('recovers a quote when a model is restored without pricing', async () => {
  const fetchPrice = vi.spyOn(GetPriceApiService, 'getPrice').mockResolvedValue(quote as never);
  await renderOrder({ generation_id: 'g' });
  expect(fetchPrice).toHaveBeenCalledWith('g', 'auth-token');
  expect(container.textContent).toContain('$25.00');
});

it('blocks progression on missing pricing and allows a failed quote to be retried', async () => {
  const fetchPrice = vi.spyOn(GetPriceApiService, 'getPrice').mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(quote as never);
  await renderOrder({ generation_id: 'g' });
  expect(container.querySelector<HTMLButtonElement>('button.checkout-primary')!.disabled).toBe(true);
  await click('Try again');
  expect(fetchPrice).toHaveBeenCalledTimes(2);
  expect(container.querySelector<HTMLButtonElement>('button.checkout-primary')!.disabled).toBe(false);
});

it('progresses contact → payment, sends auth, retains details when editing, and never caches contact or secrets', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret' });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(mocks.initCheckout).toHaveBeenCalledWith(expect.objectContaining({ elementsOptions: expect.objectContaining({ appearance: expect.objectContaining({ variables: expect.objectContaining({ colorPrimary: '#f44336' }) }) }) }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Frog', generationId: 'g', uiMode: 'custom', priceCents: 2500 }), 'auth-token');
  expect(container.querySelector('.checkout-payment-element')).not.toBeNull();
  expect(mocks.mount).toHaveBeenCalled();
  expect(container.textContent).not.toContain('Continue to secure payment');
  expect(container.querySelector('#checkout-step-2')!.hasAttribute('hidden')).toBe(false);
  const storage = localStorage.getItem('orderState')!;
  expect(storage).not.toContain(details.email); expect(storage).not.toContain(details.line1); expect(storage).not.toContain('secret');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to contact and delivery"]')!.click());
  expect(container.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe(details.email);
  expect(mocks.destroy).toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('order_step_changed', expect.objectContaining({ step: 'Contact & delivery', direction: 'back' }));
});

it('retains contact data when session creation fails and supports retry', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ session_id: 'retry', client_secret: 'secret' });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact(); expect(container.querySelector('[role="alert"]')?.textContent).toContain('please try again');
  expect(container.querySelector<HTMLInputElement>('[name="email"]')!.value).toBe(details.email);
  await submitContact(); expect(create).toHaveBeenCalledTimes(2);
});

it('keeps terms and Stripe readiness as payment gates, sends shipping securely, and displays declines', async () => {
  mocks.confirm.mockResolvedValue({ type: 'error', error: { message: 'Your card was declined.', code: 'paymentFailed' } });
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.confirm).toHaveBeenCalledWith({ email: details.email, shippingAddress: getShippingContact(details, 'US'), redirect: 'if_required' });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your card was declined');
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
});

it('provides recovery when Stripe fails to initialize', async () => {
  mocks.loadStripe.mockRejectedValueOnce(new Error('Offline'));
  const retry = vi.fn();
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="CA" totalCents={2500} onBack={vi.fn()} onRetry={retry} />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Payment could not load');
  await click('Try again'); expect(retry).toHaveBeenCalledOnce();
});

it('keeps contact details and fails on the page when payment configuration is missing', async () => {
  vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', '');
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs', checkout_url: 'https://checkout.stripe.com/c/pay/cs' });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(create).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('We couldn’t start payment');
  expect(container.querySelector<HTMLInputElement>('[name="email"]')?.value).toBe(details.email);
  expect(container.textContent).not.toContain('Continue to secure payment');
  expect(container.querySelector('.checkout-payment-element')).toBeNull();
});

it('rejects a hosted session instead of switching to a separate checkout', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs', checkout_url: 'https://checkout.stripe.com/c/pay/cs' });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ uiMode: 'custom' }), 'auth-token');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('We couldn’t start payment');
  expect(container.querySelector('#checkout-step-2')?.hasAttribute('hidden')).toBe(true);
  expect(mocks.initCheckout).not.toHaveBeenCalled();
});

it('locks completed steps during confirmation and releases them after a recoverable error', async () => {
  vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret' });
  let finish!: (value: unknown) => void;
  mocks.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  act(() => container.querySelector('#checkout-step-2 form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const contactEdit = container.querySelector<HTMLButtonElement>('.checkout-step-bar.is-complete')!;
  expect(contactEdit.disabled).toBe(true);
  await act(async () => finish({ type: 'error', error: { message: 'Please try another card.', code: 'paymentFailed' } }));
  expect(contactEdit.disabled).toBe(false);
});

it('bounds a stalled payment load and provides a retry', async () => {
  vi.useFakeTimers(); mocks.loadStripe.mockReturnValue(new Promise(() => {}));
  try {
    await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading secure payment');
    await act(async () => vi.advanceTimersByTime(20000));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Payment could not load');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('restores the selected model and price when returning from hosted checkout', async () => {
  localStorage.setItem('orderState', JSON.stringify({ generation_id: 'g', priceData: quote }));
  await act(async () => root.render(<MemoryRouter initialEntries={['/order']}><OrderKit /></MemoryRouter>));
  expect(container.textContent).toContain('$25.00');
  expect(container.querySelector<HTMLButtonElement>('button.checkout-primary')!.disabled).toBe(false);
});

it('updates the displayed total from the authoritative checkout quote', async () => {
  vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret', price_data: { ...quote, total_price: 60 } });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(container.querySelector('#checkout-step-2 button[type="submit"]')?.textContent).toBe('Pay $30.00');
  expect(container.querySelector('.checkout-total')?.textContent).toContain('$30.00');
});


it('orders card, Apple Pay, PayPal, Google Pay and marks unconfigured PayPal unavailable', async () => {
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  ['Card payment', 'Apple Pay', 'PayPal', 'Google Pay'].forEach((name, index) => expect(options[index].textContent).toContain(name));
  expect(options[2].disabled).toBe(true);
  expect(container.textContent).toContain('PayPal is not available yet.');
  await click('Apple Pay');
  expect(options[1].getAttribute('aria-checked')).toBe('true');
  expect(mocks.walletUpdate).toHaveBeenCalledWith(expect.objectContaining({ paymentMethods: expect.objectContaining({ applePay: 'always', googlePay: 'never' }) }));
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.hidden).toBe(true);
  expect(container.querySelector('.checkout-payment-element')!.hasAttribute('hidden')).toBe(true);
});

it('keeps unavailable wallets disabled without blocking card payment', async () => {
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  act(() => mocks.walletEvents.loaderror?.());
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  expect(options[1].disabled).toBe(true); expect(options[3].disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
});

it('confirms a wallet with the same checkout session, shipping and terms gate', async () => {
  mocks.confirm.mockResolvedValue({ type: 'error', error: { message: 'Please retry.', code: 'paymentFailed' } });
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="CA" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  await click('Google Pay');
  const resolve = vi.fn();
  act(() => mocks.walletEvents.click?.({ resolve }));
  expect(resolve).not.toHaveBeenCalled();
  await act(async () => mocks.walletEvents.confirm?.({ expressPaymentType: 'google_pay' }));
  expect(mocks.confirm).not.toHaveBeenCalled();
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  act(() => mocks.walletEvents.click?.({ resolve })); expect(resolve).toHaveBeenCalledOnce();
  const walletEvent = { expressPaymentType: 'google_pay' };
  await act(async () => mocks.walletEvents.confirm?.(walletEvent));
  expect(mocks.confirm).toHaveBeenCalledWith({ email: details.email, shippingAddress: getShippingContact(details, 'CA'), redirect: 'if_required', expressCheckoutConfirmEvent: walletEvent });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please retry.');
});
