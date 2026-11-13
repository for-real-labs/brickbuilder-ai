import { orderPricing } from './fixtures/orderPricing';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import OrderKit from '../src/pages/OrderKit';
import { CheckoutPayment } from '../src/components/checkout/CheckoutPayment';
import { getOrderPricing, getShippingContact } from '../src/utils/orderCheckout';
import { CreateCheckoutSessionApiService } from '../src/services/createCheckoutSessionApi';
import { GetPriceApiService } from '../src/services/getPriceApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import posthog from 'posthog-js';
import shippingCountries from '../src/data/shippingCountries.json';

const mocks = vi.hoisted(() => ({ applyPromotionCode: vi.fn(), removePromotionCode: vi.fn(), confirm: vi.fn(), mount: vi.fn(), destroy: vi.fn(), loadActions: vi.fn(), loadStripe: vi.fn(), initCheckoutElementsSdk: vi.fn(), walletUpdate: vi.fn(), walletDestroy: vi.fn(), walletCreate: vi.fn(), walletMount: vi.fn(), walletEvents: {} as Record<string, (event?: unknown) => void>, paymentEvents: {} as Record<string, (event?: unknown) => void> }));
vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: mocks.loadStripe }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ showModelControls }: { showModelControls?: boolean }) => <div data-testid="model-preview" data-controls={String(showModelControls)}>Model preview</div> }));
vi.mock('../src/services/ldrToMpdApi', () => ({ LdrToMpdApiService: { convertLdrToMpd: async () => ({ mpd_content: '0 Frog' }) } }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
vi.mock('../src/services/getGenerationApi', () => ({ GetGenerationApiService: { getGeneration: async () => ({ name: 'Frog', status: 'completed', ldr_content: '0 Frog' }) } }));
vi.mock('../src/contexts/PetContext', () => ({ usePet: () => ({ pet: { id: 'clik' } }) }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, session: null }) }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'auth-token' } } }) } } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const quote = { total_price: 50, order_pricing: orderPricing(5000), total_weight: 0.1, total_parts: 240 };
const details = { email: 'test@example.com', firstName: 'Test', lastName: 'Builder', line1: '123 Test Street', line2: '', city: 'Chicago', region: 'IL', postalCode: '60601' };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.spyOn(GetPriceApiService, 'getPrice').mockResolvedValue(quote as never);
  vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', 'pk_test_example');
  mocks.applyPromotionCode.mockReset(); mocks.removePromotionCode.mockReset();
  mocks.confirm.mockReset(); mocks.destroy.mockReset(); mocks.mount.mockReset();
  mocks.paymentEvents = {}; mocks.walletEvents = {}; mocks.walletUpdate.mockReset(); mocks.walletDestroy.mockReset();
  mocks.mount.mockImplementation(() => mocks.paymentEvents.ready?.());
  mocks.loadActions.mockResolvedValue({ type: 'success', actions: { confirm: mocks.confirm, applyPromotionCode: mocks.applyPromotionCode, removePromotionCode: mocks.removePromotionCode } });
  mocks.initCheckoutElementsSdk.mockReset();
  mocks.walletCreate.mockReset(); mocks.walletMount.mockReset();
  mocks.walletMount.mockImplementation(() => mocks.walletEvents.ready?.({ availablePaymentMethods: { applePay: true, googlePay: true } }));
  mocks.walletCreate.mockImplementation((options) => {
    if (!['buy', 'subscribe'].includes(options.buttonType.applePay)) throw new Error('Unsupported Apple Pay button type');
    if (options.layout?.overflow === 'never' && options.layout?.maxRows > 0) throw new Error('Stripe does not allow maxRows with overflow never');
    return {
      on: (event: string, callback: (event?: unknown) => void) => { mocks.walletEvents[event] = callback; },
      mount: mocks.walletMount, update: mocks.walletUpdate, destroy: mocks.walletDestroy,
    };
  });
  mocks.initCheckoutElementsSdk.mockImplementation(() => ({ loadActions: mocks.loadActions, createPaymentElement: () => ({
    on: (event: string, callback: (event?: unknown) => void) => { mocks.paymentEvents[event] = callback; }, mount: mocks.mount, destroy: mocks.destroy,
  }), createExpressCheckoutElement: mocks.walletCreate }));
  mocks.loadStripe.mockResolvedValue({ initCheckoutElementsSdk: mocks.initCheckoutElementsSdk });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllEnvs(); });
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(text))!;
  await act(async () => button.click());
};
const renderOrder = async (state: object = { generation_id: 'g', priceData: quote }) => act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/order', state }]}><OrderKit /></MemoryRouter>));

it('opens the fulfillment postcard model from its link instead of an unrelated cached checkout', async () => {
  localStorage.setItem('orderState', JSON.stringify({ generation_id: 'old-model', name: 'Old model' }));
  const read = vi.spyOn(GetGenerationApiService, 'getGeneration');
  await act(async () => root.render(<MemoryRouter initialEntries={['/order?id=purchased-model']}><OrderKit /></MemoryRouter>));
  expect(read).toHaveBeenCalledWith('purchased-model', expect.any(AbortSignal));
  expect(container.textContent).not.toContain('Old model');
});
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
  expect(getOrderPricing({ total_price: 20, order_pricing: orderPricing(2000), total_weight: -1 })).toBeNull();
  expect(getOrderPricing(quote)).toMatchObject({ partSubtotalCents: 4420, shippingCents: 580, totalCents: 5000 });
});

it('rejects cached catalog-only quotes and inconsistent server totals', () => {
  expect(getOrderPricing({ total_price: 50, total_weight: .1 })).toBeNull();
  expect(getOrderPricing({ ...quote, order_pricing: { ...orderPricing(), total_cents: 1 } })).toBeNull();
});

it('uses a text-only brand link in the checkout header', async () => {
  await renderOrder();
  expect(container.querySelector('.checkout-pricing-note')).toBeNull();
  expect(container.textContent).not.toContain('Shipping estimated for');
  expect(container.querySelector('[aria-label="About LEGO® compatible bricks"]')).not.toBeNull();
  const brand = container.querySelector('a[aria-label="BrickBuilder home"]')!;
  expect(brand.textContent).toBe('BRICKBUILDER');
  expect(brand.querySelector('svg, img')).toBeNull();
  expect(brand.getAttribute('href')).toBe('/?id=g&exact=1');
});

it.each(['navigation', 'saved order', 'last generation'])(
  'returns from checkout to the landing viewer using the %s model', async source => {
    localStorage.clear();
    localStorage.setItem('lastGenerationId', 'last');
    if (source === 'saved order') localStorage.setItem('orderState', JSON.stringify({ generation_id: 'saved', priceData: quote }));
    const state = source === 'navigation' ? { generation_id: 'ordered & model', priceData: quote } : null;
    function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output>; }
    await act(async () => root.render(<MemoryRouter initialEntries={[{ pathname: '/order', state }]}>
      <Routes><Route path="/order" element={<OrderKit />} /><Route path="/" element={<Location />} /></Routes>
    </MemoryRouter>));
    await click('Back to model');
    const id = source === 'navigation' ? 'ordered%20%26%20model' : source === 'saved order' ? 'saved' : 'last';
    expect(container.querySelector('output')?.textContent).toBe(`/?id=${id}&exact=1`);
    localStorage.clear();
  },
);

it('shows full-price line items and total without launch savings', async () => {
  await renderOrder();
  const rows = container.querySelectorAll('.checkout-price-list > div');
  expect(rows[0].querySelector('dd')?.textContent).toBe('$44.20');
  expect(rows[1].querySelector('dd')?.textContent).toBe('$5.80');
  expect(rows).toHaveLength(3);
  expect(container.textContent).not.toContain('BrickBuilder Launch Discount');
  expect(rows[0].querySelector('s')).toBeNull();
  expect(rows[1].querySelector('s')).toBeNull();
  expect(container.querySelector('.checkout-price-list')?.querySelectorAll('s')).toHaveLength(0);
  expect(container.querySelector('.checkout-total s')).toBeNull();
  expect(container.querySelector('.checkout-total')?.textContent).toContain('USD$50.00');
  expect(container.querySelector('.checkout-savings')).toBeNull();
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
  act(() => Object.entries({ ...details, line2: 'Suite 2' }).forEach(([name, value]) => fill(name, value)));
  const country = container.querySelector('select[name="country"]')!;
  await act(async () => { country.value = 'CA'; country.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.textContent).toContain('State/Province');
  await submitContact();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to contact and delivery"]')!.click());
  expect(container.querySelector('select[name="country"]')!.value).toBe('CA');
  expect(container.querySelector<HTMLInputElement>('[name="line2"]')!.value).toBe('Suite 2');
  expect(posthog.capture).toHaveBeenCalledWith('order_shipping_country_changed', expect.objectContaining({ generation_id: 'g', country: 'CA' }));
});

it('shows a useful empty checkout when no model is selected', async () => {
  await renderOrder({});
  expect(container.textContent).toContain('Your kit starts with a model');
  expect(container.querySelector('a.checkout-primary')?.getAttribute('href')).toBe('/');
});

it('recovers a quote when a model is restored without pricing', async () => {
  const fetchPrice = vi.spyOn(GetPriceApiService, 'getPrice').mockResolvedValue(quote as never);
  await renderOrder({ generation_id: 'g' });
  expect(fetchPrice).toHaveBeenCalledWith('g', 'auth-token', 'US', 1);
  expect(container.textContent).toContain('$50.00');
});

it('blocks progression on missing pricing and allows a failed quote to be retried', async () => {
  const fetchPrice = vi.spyOn(GetPriceApiService, 'getPrice').mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue(quote as never);
  await renderOrder({ generation_id: 'g' });
  expect(container.querySelector<HTMLButtonElement>('button.checkout-primary[type="submit"]')!.disabled).toBe(true);
  await click('Try again');
  expect(fetchPrice).toHaveBeenCalledTimes(2);
  expect(container.querySelector<HTMLButtonElement>('button.checkout-primary[type="submit"]')!.disabled).toBe(false);
});

it('progresses contact → payment, sends auth, retains details when editing, and never caches contact or secrets', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret' });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(mocks.initCheckoutElementsSdk).toHaveBeenCalledWith(expect.objectContaining({ elementsOptions: expect.objectContaining({ appearance: expect.objectContaining({ variables: expect.objectContaining({ colorPrimary: '#f44336' }) }) }) }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Frog', generationId: 'g', uiMode: 'elements', priceCents: 5000 }), 'auth-token');
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
  act(() => container.querySelector<HTMLInputElement>('.checkout-consent input[type="checkbox"]')!.click());
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
  vi.spyOn(GetPriceApiService, 'getPrice').mockResolvedValue(quote as never);
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
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ uiMode: 'elements' }), 'auth-token');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('We couldn’t start payment');
  expect(container.querySelector('#checkout-step-2')?.hasAttribute('hidden')).toBe(true);
  expect(mocks.initCheckoutElementsSdk).not.toHaveBeenCalled();
});

it('locks completed steps during confirmation and releases them after a recoverable error', async () => {
  vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret' });
  let finish!: (value: unknown) => void;
  mocks.confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  act(() => container.querySelector<HTMLInputElement>('.checkout-consent input[type="checkbox"]')!.click());
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
  expect(container.textContent).toContain('$50.00');
  expect(container.querySelector<HTMLButtonElement>('button.checkout-primary[type="submit"]')!.disabled).toBe(false);
});

it('updates the displayed total from the authoritative checkout quote', async () => {
  vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs_test', client_secret: 'secret', price_data: { ...quote, total_price: 60, order_pricing: orderPricing(6000) } });
  await renderOrder();
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(container.querySelector('#checkout-step-2 button[type="submit"]')?.textContent).toBe('Pay $60.00');
  expect(container.querySelector('.checkout-total')?.textContent).toContain('$60.00');
});


it('offers working wallet choices with a valid Stripe layout and omits unconfigured PayPal', async () => {
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  ['Card payment', 'Apple Pay', 'Google Pay'].forEach((name, index) => expect(options[index].textContent).toContain(name));
  expect(container.querySelector('.checkout-wallet-payment')!.hasAttribute('hidden')).toBe(false);
  expect(container.querySelector('.checkout-wallet-payment > div')!.hasAttribute('hidden')).toBe(false);
  expect(options[1].disabled).toBe(false); expect(options[2].disabled).toBe(false);
  expect(mocks.walletCreate).toHaveBeenCalledWith(expect.objectContaining({ buttonType: { applePay: 'buy', googlePay: 'pay' } }));
  expect(container.textContent).not.toContain('PayPal');
  expect(container.querySelector('[aria-label="Back to contact and delivery"]')).not.toBeNull();
  await click('Apple Pay');
  expect(options[1].getAttribute('aria-checked')).toBe('true');
  expect(mocks.walletCreate).toHaveBeenCalledWith(expect.objectContaining({ paymentMethods: expect.objectContaining({ applePay: 'always', googlePay: 'never' }) }));
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.hidden).toBe(true);
  expect(container.querySelector('.checkout-payment-element')!.hasAttribute('hidden')).toBe(true);
});

it('keeps unavailable wallets disabled without blocking card payment', async () => {
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  act(() => mocks.walletEvents.loaderror?.());
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  expect(options[1].disabled).toBe(true); expect(options[2].disabled).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('.checkout-consent input[type="checkbox"]')!.click());
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(container.textContent).toContain('Wallet payment could not load.');
});

it('updates delayed wallet availability and preserves the other wallet when switching methods', async () => {
  mocks.walletMount.mockImplementation(() => {});
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  expect(container.textContent).toContain('Checking wallet availability…');
  act(() => mocks.walletEvents.ready?.({}));
  act(() => mocks.walletEvents.availablepaymentmethodschange?.({ paymentMethods: { applePay: { available: true }, googlePay: { available: true } } }));
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  expect(options[1].disabled).toBe(false); expect(options[2].disabled).toBe(false);
  // A late legacy ready event must not overwrite the current eligibility result.
  act(() => mocks.walletEvents.ready?.({}));
  expect(options[1].disabled).toBe(false);
  const oldAvailability = mocks.walletEvents.availablepaymentmethodschange;
  await click('Apple Pay');
  expect(mocks.walletDestroy).toHaveBeenCalledOnce();
  act(() => oldAvailability?.({ paymentMethods: undefined }));
  expect(options[1].disabled).toBe(false); expect(options[2].disabled).toBe(false);
  act(() => mocks.walletEvents.availablepaymentmethodschange?.({ paymentMethods: { applePay: { available: true }, googlePay: { available: false } } }));
  expect(options[2].disabled).toBe(false);
  await click('Google Pay');
  act(() => mocks.walletEvents.availablepaymentmethodschange?.({ paymentMethods: undefined }));
  expect(options[1].disabled).toBe(false); expect(options[2].disabled).toBe(false);
  act(() => mocks.walletEvents.availablepaymentmethodschange?.({ paymentMethods: { applePay: { available: false }, googlePay: { available: true } } }));
  expect(options[1].disabled).toBe(false);
  await click('Card payment');
  expect(mocks.walletCreate).toHaveBeenLastCalledWith(expect.objectContaining({ paymentMethods: expect.objectContaining({ applePay: 'always', googlePay: 'always' }) }));
  act(() => mocks.walletEvents.availablepaymentmethodschange?.({ paymentMethods: undefined }));
  expect(options[1].disabled).toBe(true); expect(options[2].disabled).toBe(true);
});

it('keeps card checkout usable when wallet initialization throws', async () => {
  mocks.walletCreate.mockImplementation(() => { throw new Error('Wallet initialization failed'); });
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  expect(container.textContent).toContain('Wallet payment could not load.');
  act(() => container.querySelector<HTMLInputElement>('.checkout-consent input[type="checkbox"]')!.click());
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(posthog.capture).toHaveBeenCalledWith('order_checkout_error', expect.objectContaining({ stage: 'wallet_load' }));
});

it('confirms a wallet with the same checkout session, shipping and terms gate', async () => {
  mocks.confirm.mockResolvedValue({ type: 'error', error: { message: 'Please retry.', code: 'paymentFailed' } });
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="CA" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} />));
  await click('Google Pay');
  const walletMount = container.querySelector<HTMLElement>('.checkout-wallet-payment > div')!;
  expect(walletMount.inert).toBe(true);
  expect(walletMount.classList.contains('is-inactive')).toBe(false);
  expect(walletMount.classList.contains('checkout-wallet-disabled')).toBe(true);
  const resolve = vi.fn();
  act(() => mocks.walletEvents.click?.({ resolve }));
  expect(resolve).not.toHaveBeenCalled();
  await act(async () => mocks.walletEvents.confirm?.({ expressPaymentType: 'google_pay' }));
  expect(mocks.confirm).not.toHaveBeenCalled();
  act(() => container.querySelector<HTMLInputElement>('.checkout-consent input[type="checkbox"]')!.click());
  expect(walletMount.inert).toBe(false);
  expect(walletMount.classList.contains('checkout-wallet-disabled')).toBe(false);
  act(() => mocks.walletEvents.click?.({ resolve })); expect(resolve).toHaveBeenCalledOnce();
  const walletEvent = { expressPaymentType: 'google_pay' };
  await act(async () => mocks.walletEvents.confirm?.(walletEvent));
  expect(mocks.confirm).toHaveBeenCalledWith({ email: details.email, shippingAddress: getShippingContact(details, 'CA'), redirect: 'if_required', expressCheckoutConfirmEvent: walletEvent });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please retry.');
});


it('matches Brickwith address order and optional fields without collecting a phone number', async () => {
  await renderOrder();
  const form = container.querySelector('#checkout-step-1 form')!;
  expect(Array.from(form.querySelectorAll('input, select')).map(input => input.getAttribute('name'))).toEqual([
    'email', 'firstName', 'lastName', 'country', 'line1', 'line2', 'region', 'city', 'postalCode', 'shipInstructionsPostcard',
  ]);
  expect(container.querySelector<HTMLInputElement>('[name="line2"]')!.required).toBe(false);
  expect(container.querySelector<HTMLInputElement>('[name="region"]')!.required).toBe(false);
  expect(container.querySelector('input[type="tel"], input[name="phone"]')).toBeNull();
  expect(form.textContent).not.toMatch(/phone/i);
});

it('joins and trims recipient names and sends international addresses without a phone property', () => {
  expect(getShippingContact({ ...details, firstName: '  Test ', lastName: ' Builder  ', region: '', line2: ' Suite 2 ' }, 'GB')).toEqual({
    name: 'Test Builder', address: { line1: '123 Test Street', line2: 'Suite 2', city: 'Chicago', state: '', postal_code: '60601', country: 'GB' },
  });
});


it('tracks address field interactions without contact values', async () => {
  await renderOrder();
  act(() => fill('firstName', 'Private Name'));
  await act(async () => container.querySelector('[name="firstName"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(posthog.capture).toHaveBeenCalledWith('order_delivery_field_completed', { generation_id: 'g', field: 'firstName', filled: true });
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('Private Name');
});


it('sends the postcard choice to payment and retains it when editing contact details', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs', client_secret: 'secret' });
  await renderOrder();
  const postcard = container.querySelector<HTMLInputElement>('[name="shipInstructionsPostcard"]')!;
  expect(postcard.checked).toBe(false);
  act(() => { postcard.click(); Object.entries(details).forEach(([name, value]) => fill(name, value)); });
  await submitContact();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ shipInstructionsPostcard: true, petId: 'clik' }), 'auth-token');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to contact and delivery"]')!.click());
  expect(container.querySelector<HTMLInputElement>('[name="shipInstructionsPostcard"]')!.checked).toBe(true);
  act(() => container.querySelector<HTMLInputElement>('[name="shipInstructionsPostcard"]')!.click());
  await submitContact();
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ shipInstructionsPostcard: false }), 'auth-token');
});


it('uses the restored generation’s name and render in the postcard rather than an outdated navigation screenshot', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({
    generation_id: 'g', name: 'Garden Cottage', status: 'completed', preview_image_url: 'https://example.com/cottage.png', ldr_content: '0 Cottage',
  } as never);
  await renderOrder({ generation_id: 'g', priceData: quote, name: 'Outdated model', screenshots: { angle1: 'https://example.com/outdated.png' } });
  expect(container.querySelector('.checkout-postcard-nature')).not.toBeNull();
  expect(container.querySelector('.checkout-postcard h3')?.textContent).toBe('Garden Cottage');
  expect(container.querySelector('.checkout-postcard img')?.getAttribute('src')).toBe('https://example.com/cottage.png');
});


it('offers every verified Brickwith country and sends the selected address to checkout', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs', client_secret: 'secret', shipping_address_provided: true });
  await renderOrder();
  const select = container.querySelector<HTMLSelectElement>('[name="country"]')!;
  expect(Array.from(select.options).map(option => ({ code: option.value, name: option.textContent }))).toEqual(shippingCountries);
  expect(select.options).toHaveLength(249);
  await act(async () => { select.value = 'CX'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ shippingAddress: getShippingContact(details, 'CX') }), 'auth-token');
  act(() => container.querySelector<HTMLInputElement>('.checkout-consent input')!.click());
  await act(async () => container.querySelector('#checkout-step-2 form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.confirm).toHaveBeenCalledWith({ email: details.email, redirect: 'if_required' });
});

const renderPromoCheckout = async () => {
  const onTotalChange = vi.fn();
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs', client_secret: 'secret' }} publishableKey="pk_test_example" details={details} country="US" totalCents={2500} onBack={vi.fn()} onRetry={vi.fn()} onTotalChange={onTotalChange} />));
  act(() => {
    const input = container.querySelector('#order-promo')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' LINKEDIN ');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return onTotalChange;
};
it('applies and removes a Stripe-validated promo and updates the displayed total', async () => {
  mocks.applyPromotionCode.mockResolvedValue({ type: 'success', session: { total: { total: { minorUnitsAmount: 2000 } } } });
  mocks.removePromotionCode.mockResolvedValue({ type: 'success', session: { total: { total: { minorUnitsAmount: 2500 } } } });
  const onTotalChange = await renderPromoCheckout();
  await click('Apply');
  expect(mocks.applyPromotionCode).toHaveBeenCalledWith('LINKEDIN');
  expect(container.textContent).toContain('Pay $20.00');
  expect(onTotalChange).toHaveBeenLastCalledWith(2000);
  expect(posthog.capture).toHaveBeenCalledWith('order_promo_applied', expect.objectContaining({ total_cents: 2000 }));
  await click('Remove');
  expect(mocks.removePromotionCode).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('Pay $25.00');
  expect(onTotalChange).toHaveBeenLastCalledWith(2500);
});
it.each(['invalid', 'network'])('preserves the total and allows retry after a %s promo error', async failure => {
  if (failure === 'network') mocks.applyPromotionCode.mockRejectedValue(new Error('offline'));
  else mocks.applyPromotionCode.mockResolvedValue({ type: 'error', error: { message: 'Invalid promotion code.' } });
  await renderPromoCheckout();
  await click('Apply');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain('Pay $25.00');
  expect((container.querySelector('#order-promo') as HTMLInputElement).disabled).toBe(false);
});
it('blocks card and wallet confirmation while a promotion is changing', async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.applyPromotionCode.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await renderPromoCheckout();
  act(() => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await click('Apply');
  await act(async () => {
    container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await mocks.walletEvents.confirm?.({ expressPaymentType: 'google_pay' });
  });
  expect(mocks.confirm).not.toHaveBeenCalled();
  await act(async () => finish({ type: 'success', session: { total: { total: { minorUnitsAmount: 2000 } } } }));
});

it.each([10,20])('keeps the server-quoted %s percent savings when a promo is applied and removed', async percent => {
  const memberQuote = { ...quote, order_pricing: orderPricing(4600, 600, 1000, 'US', percent) };
  vi.mocked(GetPriceApiService.getPrice).mockResolvedValue(memberQuote as never);
  vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({
    session_id: 'cs_member', client_secret: 'secret', price_data: memberQuote,
  });
  mocks.applyPromotionCode.mockResolvedValue({ type: 'success', session: { total: { total: { minorUnitsAmount: 3800 } } } });
  mocks.removePromotionCode.mockResolvedValue({ type: 'success', session: { total: { total: { minorUnitsAmount: 4600 } } } });
  await renderOrder();
  expect(container.querySelector('.checkout-total del')?.textContent).toBe('$56.00');
  expect(container.querySelector('.checkout-member-badge')).toBeNull();
  expect(container.querySelector('.checkout-member-discount dt')?.textContent).toBe(`${percent}% subscriber discount`);
  expect(container.querySelector('.checkout-member-discount dd')?.textContent).toBe('−$10.00');
  expect(container.querySelector('.checkout-member-discount')?.previousElementSibling?.textContent).toContain('LEGO® compatible bricks');
  expect(container.querySelector('#checkout-price-breakdown .checkout-member-badge')).toBeNull();
  expect(container.querySelector('.checkout-member-discount')?.textContent).toContain('−$10.00');
  act(() => Object.entries(details).forEach(([name, value]) => fill(name, value)));
  await submitContact();
  act(() => {
    const input = container.querySelector('#order-promo')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'LINKEDIN');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Apply');
  expect(container.querySelector('.checkout-total')?.textContent).toContain('$38.00');
  expect(container.textContent).toContain('Promo discount−$8.00');
  expect(container.querySelector('.checkout-member-discount')?.textContent).toContain('−$10.00');
  await click('Remove');
  expect(container.querySelector('.checkout-total')?.textContent).toContain('$46.00');
  expect(container.querySelector('.checkout-total del')?.textContent).toBe('$56.00');
  expect(container.querySelector('.checkout-member-discount')?.textContent).toContain('−$10.00');
});

it('refreshes country shipping and ignores an older request that finishes later', async () => {
  let finishOlder: (value: unknown) => void = () => {};
  vi.mocked(GetPriceApiService.getPrice).mockResolvedValueOnce(quote as never)
    .mockImplementationOnce(() => new Promise(resolve => { finishOlder = resolve; }) as never)
    .mockResolvedValueOnce({ ...quote, order_pricing: orderPricing(5500, 1080, 0, 'PL') } as never);
  await renderOrder();
  const country = container.querySelector('select[name="country"]') as HTMLSelectElement;
  await act(async () => { country.value = 'GB'; country.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector<HTMLButtonElement>('#checkout-step-1 button[type="submit"]')?.disabled).toBe(true);
  await act(async () => { country.value = 'PL'; country.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(GetPriceApiService.getPrice).toHaveBeenLastCalledWith('g', 'auth-token', 'PL', 1);
  await act(async () => finishOlder({ ...quote, order_pricing: orderPricing(4900, 480, 0, 'GB') }));
  expect(container.querySelector('.checkout-total')?.textContent).toContain('$55.00');
  expect(country.value).toBe('PL');
});

it.each([['builder', 299, '2.99'], ['creator', 1999, '19.99']] as const)('confirms %s using the session customer email, without shipping or a promo form', async (plan, cents, price) => {
  mocks.confirm.mockResolvedValue({ type: 'error', error: { message: 'Your card was declined.', code: 'paymentFailed' } });
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs_plan', client_secret: 'secret' }} publishableKey="pk_test_example"
    subscriptionPlan={plan} email="builder@example.test" totalCents={cents} onBack={vi.fn()} onRetry={vi.fn()} />));
  expect(container.textContent).toContain(`Subscribe · $${price} / month`);
  expect(container.textContent).not.toContain('Renews monthly until canceled');
  expect(container.querySelector('#order-promo')).toBeNull();
  expect(container.querySelector('.checkout-back')).toBeNull();
  expect(mocks.walletCreate).toHaveBeenCalledWith(expect.objectContaining({ buttonType: { applePay: 'subscribe', googlePay: 'subscribe' } }));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.confirm).toHaveBeenCalledWith({ redirect: 'if_required' });
  const walletEvent = { paymentFailed: vi.fn() };
  await act(async () => mocks.walletEvents.confirm(walletEvent));
  expect(mocks.confirm).toHaveBeenLastCalledWith({ redirect: 'if_required', expressCheckoutConfirmEvent: walletEvent });
  expect(container.textContent).toContain('Your card was declined.');
  expect(posthog.capture).toHaveBeenCalledWith('plan_checkout_clicked', expect.objectContaining({ plan_key: plan, total_cents: cents }));
});

it('requotes quantities, retains delivery, and sends the selected number to payment', async () => {
  const create = vi.spyOn(CreateCheckoutSessionApiService, 'createCheckoutSession').mockResolvedValue({ session_id: 'cs', client_secret: 'secret' });
  await renderOrder();
  await act(async () => fill('firstName', 'Jake'));
  vi.mocked(GetPriceApiService.getPrice).mockResolvedValue({ ...quote, total_parts: 720, order_pricing: orderPricing(14000) } as never);
  await act(async () => {
    const select = container.querySelector('[aria-label="Model quantity"]') as HTMLSelectElement;
    select.value = '3';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(GetPriceApiService.getPrice).toHaveBeenLastCalledWith('g', 'auth-token', 'US', 3);
  expect(container.querySelector<HTMLInputElement>('[name="firstName"]')?.value).toBe('Jake');
  expect(container.querySelector('.checkout-summary-model')?.textContent).toContain('720 pieces');
  expect(container.querySelector('.checkout-total')?.textContent).toContain('$140.00');
  expect(JSON.parse(localStorage.getItem('orderState')!).quantity).toBe(3);
  expect(posthog.capture).toHaveBeenCalledWith('order_quantity_changed', { generation_id: 'g', quantity: 3 });
  await submitContact();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3, priceCents: 14000 }), 'auth-token');
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Model quantity"]')?.disabled).toBe(true);
});

it('restores the selected quantity when reloading a model link', async () => {
  localStorage.setItem('orderState', JSON.stringify({ generation_id: 'saved-model', quantity: 4 }));
  await act(async () => root.render(<MemoryRouter initialEntries={['/order?id=saved-model']}><OrderKit /></MemoryRouter>));
  expect(container.querySelector<HTMLSelectElement>('[aria-label="Model quantity"]')?.value).toBe('4');
  expect(GetPriceApiService.getPrice).toHaveBeenLastCalledWith('saved-model', 'auth-token', 'US', 4);
});

it('confirms one-time credits inline without subscription, shipping or product promos', async () => {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  mocks.confirm.mockResolvedValue({ type: 'success' });
  await act(async () => root.render(<CheckoutPayment session={{ session_id: 'cs_credit', client_secret: 'secret' }} publishableKey="pk_test_example"
    creditPurchase email="buyer@example.test" totalCents={1000} onBack={vi.fn()} onRetry={vi.fn()} />));
  expect(container.textContent).toContain('Pay $10.00');
  expect(container.querySelector('#order-promo')).toBeNull();
  expect(container.querySelector('.checkout-back')).toBeNull();
  expect(mocks.walletCreate).toHaveBeenCalledWith(expect.objectContaining({ buttonType: { applePay: 'buy', googlePay: 'pay' } }));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(mocks.confirm).toHaveBeenCalledWith({ email: 'buyer@example.test', redirect: 'if_required' });
  expect(assign).toHaveBeenCalledWith('/billing?checkout=success&session_id=cs_credit');
});
