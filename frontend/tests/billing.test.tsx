import React, { act, useEffect } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { BillingProvider, useBilling } from '../src/contexts/BillingContext';
import { BillingOverlays, MonthlyCreditUsage, CreditBalance, CreditNudge, PlanGrid, GenerationCreditQuote } from '../src/components/BillingComponents';
import BillingPage from '../src/pages/BillingPage';
import { PlanPopupRedirect } from '../src/components/PlanPopupRedirect';
import { billingApi, openStripe, type BillingAccount } from '../src/services/billingApi';

const auth = vi.hoisted(() => ({ user: { id: 'builder-1' } as { id: string } | null }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/contexts/PetContext', () => ({ usePet: () => ({ pet: { name: 'Pip', id: 'pip' } }) }));
vi.mock('../src/components/PetCompanion', () => ({ PetAvatar: ({ id = 'pip' }) => <span data-pet={id} /> }));
vi.mock('../src/components/LoginModal', () => ({ default: ({ open }: { open: boolean }) => open ? <div role="dialog">Sign in to build</div> : null }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/billingApi', async importOriginal => ({ ...await importOriginal<typeof import('../src/services/billingApi')>(),
  billingApi: { creditCheckout: vi.fn(), appleCreditPrepare: vi.fn(), applePrepare: vi.fn(), appleSync: vi.fn(), plans: vi.fn(), account: vi.fn(), checkout: vi.fn(), portal: vi.fn(), sync: vi.fn() }, openStripe: vi.fn(),
}));

function OpenPlansPopup() {
  const { openUpgrade } = useBilling();
  useEffect(() => { openUpgrade('pricing_button'); }, [openUpgrade]);
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let account: BillingAccount;
const render = async (children: React.ReactNode) => act(async () => root.render(<HelmetProvider><MemoryRouter><BillingProvider>{children}<BillingOverlays /></BillingProvider></MemoryRouter></HelmetProvider>));
const click = async (text: string) => act(async () => {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  expect(button, text).toBeDefined(); button!.click();
});

const selectPlan = async (name: string) => act(async () => {
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${name} plan"] .billing-plan-button`);
  expect(button).not.toBeNull();
  expect(button?.textContent).toBe('Select Plan');
  button!.click();
});

beforeEach(async () => {
  vi.clearAllMocks();
  delete window.__BRICKBUILDER_NATIVE_APP__;
  delete window.ReactNativeWebView;
  auth.user = { id: 'builder-1' };
  account = { plan_key: 'free', monthly_credits: 300, monthly_remaining: 2, bonus_remaining: 0, credits_remaining: 2,
    period_start: '2026-10-01T00:00:00Z', period_end: '2099-11-01T00:00:00Z', subscription_status: 'none',
    cancel_at_period_end: false, has_subscription: false, enabled: true, history: [] };
  const { INITIAL_PLANS } = await import('../src/services/billingApi');
  vi.mocked(billingApi.plans).mockResolvedValue({ enabled: true, ready: true, plans: INITIAL_PLANS });
  vi.mocked(billingApi.account).mockImplementation(async () => account);
  vi.mocked(billingApi.sync).mockImplementation(async () => account);
  vi.mocked(billingApi.checkout).mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/test' });
  vi.mocked(billingApi.portal).mockResolvedValue({ url: 'https://billing.stripe.com/p/session/test' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { delete window.__BRICKBUILDER_NATIVE_APP__; delete window.ReactNativeWebView; act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('opens the balance upgrade flow, displays monthly terms, and starts the selected plan', async () => {
  await render(<CreditBalance />);
  expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('2 credits');
  await click('credits');
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(container.querySelectorAll('.billing-plan:not(.billing-credit-pack)')).toHaveLength(2);
  expect(container.textContent).toContain('Web monthly credits reset and do not roll over');
  expect(container.querySelector('.billing-dialog .billing-member-intro strong')?.textContent).toBe('20% off LEGO® set purchases!');
  expect(container.querySelector('.billing-dialog .billing-fine-print')?.textContent).not.toContain('Legacy bonuses never expire.');
  await selectPlan('Creator');
  expect(billingApi.checkout).toHaveBeenCalledWith('creator');
  expect(openStripe).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/test');
  expect(posthog.capture).toHaveBeenCalledWith('billing_checkout_started', { plan_key: 'creator', source: 'credit_balance' });
  await act(async () => container.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(container.querySelector('dialog')).toBeNull();
  expect(document.body.style.overflow).toBe('');
});

it('asks guests to sign in before creating a subscription', async () => {
  auth.user = null;
  await render(<PlanGrid source="pricing_page" />);
  expect(container.querySelector('[aria-label="Free plan"]')?.textContent).toContain('LDR downloads for LEGO® sets');
  await selectPlan('Builder');
  expect(container.textContent).toContain('Sign in to build');
  expect(billingApi.checkout).not.toHaveBeenCalled();
  expect(billingApi.account).not.toHaveBeenCalled();
});

it('refreshes an exhausted wallet without competing with the personal-key pet prompt', async () => {
  await render(<CreditNudge />);
  expect(container.textContent).toContain('Pip: 2 credits left.');
  expect(container.querySelector('[data-pet="pip"]')).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event('brickbuilder:credits-required')));
  expect(container.querySelector('dialog')).toBeNull();
  expect(posthog.capture).not.toHaveBeenCalledWith('billing_upgrade_opened', expect.objectContaining({ source: 'credits_exhausted' }));
});

it('does not show or report a nudge for a paid account with plenty of credits', async () => {
  account = { ...account, plan_key: 'creator', has_subscription: true, subscription_status: 'active', credits_remaining: 100, monthly_remaining: 100, monthly_credits: 100 };
  await render(<CreditNudge />);
  expect(container.querySelector('.credit-nudge')).toBeNull();
  expect(posthog.capture).not.toHaveBeenCalledWith('billing_nudge_shown', expect.objectContaining({ plan_key: 'creator' }));
});

it('directs an exhausted highest-tier subscriber to additional credit purchases', async () => {
  account = { ...account, plan_key: 'master', has_subscription: true, subscription_status: 'active', credits_remaining: 0, monthly_remaining: 0, monthly_credits: 1000 };
  await render(<CreditNudge />);
  expect(container.textContent).toContain('Buy credits');
  expect(container.textContent).not.toContain('Get more credits');
  await click('Buy credits');
  expect(posthog.capture).toHaveBeenCalledWith('billing_usage_clicked', { source: 'low_credits' });
});

it('offers explicit cancellation and sends it to the authenticated portal', async () => {
  account = { ...account, plan_key: 'builder', has_subscription: true, subscription_status: 'active', monthly_credits: 500 };
  await render(<BillingPage />);
  await click('Cancel subscription');
  expect(billingApi.portal).toHaveBeenCalledWith('cancel');
  expect(openStripe).toHaveBeenCalledWith('https://billing.stripe.com/p/session/test');
  expect(posthog.capture).toHaveBeenCalledWith('billing_cancel_clicked', { source: 'billing' });
});

it('clearly confirms an end-of-period cancellation without offering another cancellation', async () => {
  account = { ...account, plan_key: 'builder', has_subscription: true, subscription_status: 'active', cancel_at_period_end: true };
  await render(<BillingPage />);
  expect(container.textContent).toContain('You won’t be charged again.');
  expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Cancel subscription')).toBe(false);
  expect(container.textContent).toContain('Manage billing & receipts');
});

it('keeps a failed checkout in the app with a useful error', async () => {
  vi.mocked(billingApi.checkout).mockRejectedValueOnce(new Error('Please try again in a moment.'));
  await render(<OpenPlansPopup />);
  await selectPlan('Creator');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please try again in a moment.');
  expect(openStripe).not.toHaveBeenCalled();
  expect(container.textContent).toContain('One-time credits never expire');
});

it('disables paid checkout until billing is enabled', async () => {
  account.enabled = false;
  vi.mocked(billingApi.plans).mockResolvedValueOnce({ enabled: false, ready: true, plans: (await import('../src/services/billingApi')).INITIAL_PLANS });
  await render(<PlanGrid source="pricing_page" />);
  expect(container.textContent).toContain('Coming soon');
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'Coming soon').every(b => b.disabled)).toBe(true);
  expect(billingApi.checkout).not.toHaveBeenCalled();
});

it('keeps unavailable billing presentable and refreshes availability when the visitor returns', async () => {
  auth.user = null;
  vi.mocked(billingApi.plans).mockRejectedValueOnce(new Error('Backend rollout pending'));
  await render(<OpenPlansPopup />);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Monthly plans are getting ready');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Builder plan"] .billing-plan-button')?.disabled).toBe(false);
});

it('keeps the account page useful while its new API is awaiting deployment', async () => {
  vi.mocked(billingApi.plans).mockRejectedValueOnce(new Error('Not deployed'));
  vi.mocked(billingApi.account).mockRejectedValueOnce(new Error('Not deployed'));
  vi.mocked(billingApi.sync).mockRejectedValueOnce(new Error('Not deployed'));
  await render(<BillingPage />);
  expect(container.textContent).toContain('Your current building access continues');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('a[href="/"]')).not.toBeNull();
});


it('shows the monthly allowances and generation estimates on every plan', async () => {
  await render(<PlanGrid source="test" />);
  const cards = [...container.querySelectorAll('.billing-plan:not(.billing-credit-pack)')];
  expect(cards.map(card => card.querySelector('.billing-credit-allocation strong')?.textContent)).toEqual(['75', '225', '1,500']);
  expect(cards.map(card => card.querySelector('.billing-price strong')?.textContent)).toEqual(['$0', '$2.99', '$19.99']);
  expect(cards.map(card => card.querySelector('.billing-set-estimate')?.textContent)).toEqual(['About 5 LEGO® generations per month', 'About 15 LEGO® generations per month', 'About 100 LEGO® generations per month']);
  for (const card of cards) {
    expect([...card.querySelectorAll('li')].map(item => item.textContent)).toEqual(['LDR downloads for LEGO® sets', 'IO exports for LEGO® sets', 'Building instructions', '20% off every LEGO® set purchase']);
  }
});

it.each([[300, 270, 30], [800, 0, 800], [800, 1000, 0], [0, 0, 0]])('bounds monthly usage for allowance %s and balance %s', async (total, remaining, used) => {
  await render(<MonthlyCreditUsage account={{ monthly_credits: total, monthly_remaining: remaining }} />);
  const progress = container.querySelector('progress')!;
  expect(progress.value).toBe(used);
  expect(progress.max).toBe(Math.max(1, total));
  expect(progress.getAttribute('aria-valuetext')).toBe(`${used} of ${total} monthly credits used`);
});

it('shows monthly usage beneath the popup title without counting bonuses or Apple credits', async () => {
  account = { ...account, monthly_remaining: 270, bonus_remaining: 5, apple_remaining: 800 };
  await render(<CreditBalance />);
  await click('credits');
  const heading = container.querySelector('.billing-dialog-heading')!;
  expect(heading.textContent).toContain('You’ve used 30 of your 300 monthly credits.');
  expect(heading.textContent).not.toContain('BUILD WITH');
  expect(heading.querySelector('progress')?.value).toBe(30);
});

it.each(['Pricing', 'Explore plans', 'Compare all plans & credit details'])('opens the shared credits popup from %s', async label => {
  await render(<BillingPage />);
  expect(container.querySelector('dialog')).toBeNull();
  await click(label);
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(container.querySelectorAll('.billing-dialog .billing-plan')).toHaveLength(2);
  expect(container.querySelector('.billing-dialog .billing-member-intro strong')?.textContent).toBe('20% off LEGO® set purchases!');
  expect(container.querySelector('.billing-dialog h1')?.classList.contains('sr-only')).toBe(true);
  expect(container.textContent).not.toContain('Your next big idea starts here.');
  expect(container.querySelector('a[href="/pricing"]')).toBeNull();
});

it('redirects a saved pricing URL to the landing page with the same popup', async () => {
  await act(async () => root.render(<HelmetProvider><MemoryRouter initialEntries={['/pricing']}><BillingProvider>
    <Routes><Route path="/pricing" element={<PlanPopupRedirect />} /><Route path="/" element={<p>Landing page</p>} /></Routes>
    <BillingOverlays /></BillingProvider></MemoryRouter></HelmetProvider>));
  expect(container.textContent).toContain('Landing page');
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(posthog.capture).toHaveBeenCalledWith('billing_upgrade_opened', expect.objectContaining({ source: 'pricing_link' }));
});

it.each([
  ['free', 75, 5, 'Upgrade plan'], ['builder', 225, 15, 'Upgrade plan'],
  ['creator', 1500, 100, 'Change plan'], ['master', 1000, 50, 'Change plan'],
] as const)('summarizes %s and opens the right plan action', async (key, credits, generations, label) => {
  account = { ...account, plan_key: key, monthly_credits: credits, has_subscription: key !== 'free' };
  await render(<BillingPage />);
  const section = container.querySelector('.billing-account-plan')!.closest('section')!;
  expect(section.querySelector('.billing-plan-allowance')?.textContent).toBe(`${credits.toLocaleString()} credits each month. About ${generations} LEGO® generations per month.`);
  expect(section.textContent).not.toContain('No payment method needed');
  await click(label);
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(posthog.capture).toHaveBeenCalledWith('billing_plan_action_clicked', { plan_key: key, action: label === 'Change plan' ? 'change' : 'upgrade' });
});

it('uses the Apple subscription allowance instead of the separate free wallet', async () => {
  account = { ...account, subscription_provider: 'apple', apple_plan: 'creator', apple_expires_at: '2099-11-01T00:00:00Z', has_subscription: true, monthly_credits: 75 };
  await render(<BillingPage />);
  expect(container.querySelector('.billing-plan-allowance')?.textContent).toBe('1,500 credits each month. About 100 LEGO® generations per month.');
  expect(container.querySelector('.billing-plan-actions')?.textContent).toContain('Change plan');
});

it.each([false,true])('explains guest access without requiring login and offers optional signup (All parts: %s)', async allParts => {
  auth.user = null;
  await render(<GenerationCreditQuote allParts={allParts} />);
  expect(container.textContent).toContain(allParts ? '20 credits' : '2 credits');
  expect(container.textContent).toContain('75 lifetime guest credits: 3 All parts builds or 37 Basic builds, or a mix. No login needed.');
  expect(container.textContent).not.toContain('One guest trial');
  await click('Sign in for 75 free monthly credits');
  expect(container.textContent).toContain('Sign in to build');
  expect(posthog.capture).toHaveBeenCalledWith('billing_mode_sign_in_clicked', { mode: allParts ? 'all_parts' : 'basic' });
  expect(billingApi.checkout).not.toHaveBeenCalled();
});

it('lets Free accounts use All parts without a paid-plan nudge', async () => {
  account = { ...account, monthly_remaining: 300, credits_remaining: 300 };
  await render(<GenerationCreditQuote allParts />);
  expect(container.textContent).toContain('300 monthly credits available');
  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).not.toContain('Choose a monthly plan');
});

it('pauses new sales at capacity while keeping cancellation accessible', async () => {
  account = { ...account, plan_key: 'builder', has_subscription: true, subscription_status: 'active', checkout_available: false };
  vi.mocked(billingApi.plans).mockResolvedValue({ enabled: true, ready: true, checkout_available: false, plans: (await import('../src/services/billingApi')).INITIAL_PLANS });
  await render(<><PlanGrid source="pricing_page" /><BillingPage /></>);
  expect([...container.querySelectorAll('button')].filter(b => b.textContent === 'At capacity').every(b => b.disabled)).toBe(true);
  await click('Cancel subscription');
  expect(billingApi.portal).toHaveBeenCalledWith('cancel');
});

it('shows the total and monthly balances without separate purchased or legacy rows', async () => {
  account = { ...account, bonus_remaining: 100, bonus_available: 3, credits_remaining: 5 };
  await render(<BillingPage />);
  expect(container.textContent).not.toContain('Legacy bonus balance');
  expect(container.querySelector('.billing-big-balance')?.textContent).toBe('5');
  expect(container.textContent).not.toContain('ready for your next idea');
  expect(container.querySelector('.billing-account-title')?.textContent).not.toContain('More ideas ahead. Here’s where you stand.');
  expect(container.querySelector('.billing-account-title')?.textContent).toBe('Credits & billing');
  expect([...container.querySelectorAll('.billing-balance-row')].map(row => row.textContent)).toEqual(['Monthly credits2 / 300']);
  expect(container.textContent).not.toContain('bonus credits available for Basic builds this month');
  expect(container.textContent).not.toContain('Maximum 5 per month.');
});


it('does not imply that legacy bonuses can fund an All parts build', async () => {
  account = { ...account, plan_key: 'builder', has_subscription: true, subscription_status: 'active',
    monthly_credits: 500, monthly_remaining: 10, bonus_remaining: 100, bonus_available: 5, credits_remaining: 15 };
  await render(<><GenerationCreditQuote allParts /><CreditNudge /></>);
  expect(container.textContent).toContain('10 monthly credits available. Legacy bonuses are for Basic only.');
  expect(container.querySelector('.credit-nudge--low')).not.toBeNull();
});


it('uses localized Apple prices and native purchases without Stripe checkout', async () => {
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '0.2.0', applePurchases: true };
  const sent: Record<string, string>[] = [];
  window.ReactNativeWebView = { postMessage: raw => {
    const message = JSON.parse(raw); sent.push(message);
    const result = message.action === 'products' ? [{ id: 'ai.brickbuilder.app.builder.monthly', displayPrice: '€9.99' }]
      : message.action === 'pending' || message.action === 'restore' ? [] : null;
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('brickbuilder:apple-purchases', { detail: { id: message.id, result } })));
  } };
  const { INITIAL_PLANS } = await import('../src/services/billingApi');
  vi.mocked(billingApi.plans).mockResolvedValue({ enabled: true, ready: true, apple_ready: true, plans: INITIAL_PLANS });
  vi.mocked(billingApi.applePrepare).mockResolvedValue({ app_account_token: '00000000-0000-4000-8000-000000000001' });
  await render(<PlanGrid source="pricing_page" />);
  expect(container.textContent).toContain('€9.99');
  expect(container.textContent).toContain('Restore purchases');
  expect(container.textContent).toContain('never expire');
  expect(container.textContent).not.toContain('$9');
  await selectPlan('Builder');
  expect(sent).toContainEqual(expect.objectContaining({ action: 'buy', product: 'ai.brickbuilder.app.builder.monthly' }));
  expect(billingApi.checkout).not.toHaveBeenCalled();
  expect(openStripe).not.toHaveBeenCalled();
});

it('keeps old iOS shells off web checkout and explains the required update', async () => {
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '0.1.0' };
  await render(<PlanGrid source="pricing_page" />);
  expect(container.textContent).toContain('Update BrickBuilder');
  expect([...container.querySelectorAll('.billing-plan-button')].every(b => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(billingApi.checkout).not.toHaveBeenCalled();
});

it('restores through the server before finishing the Apple transaction', async () => {
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '0.2.0', applePurchases: true };
  const actions: string[] = [];
  window.ReactNativeWebView = { postMessage: raw => {
    const message = JSON.parse(raw); actions.push(message.action);
    if (message.action === 'finish') expect(billingApi.appleSync).toHaveBeenCalledWith('123');
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('brickbuilder:apple-purchases', { detail: {
      id: message.id, result: message.action === 'restore' ? ['123'] : [],
    } })));
  } };
  vi.mocked(billingApi.appleSync).mockResolvedValue(account);
  await render(<PlanGrid source="pricing_page" />);
  await click('Restore purchases');
  expect(actions).toContain('finish');
  expect(billingApi.appleSync).toHaveBeenCalledWith('123');
});

it.each([false, true])('only reports restore failure when server verification fails (%s)', async syncFails => {
  window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '1.0.4', applePurchases: true };
  const actions: string[] = [];
  window.ReactNativeWebView = { postMessage: raw => {
    const message = JSON.parse(raw); actions.push(message.action);
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('brickbuilder:apple-purchases', { detail: {
      id: message.id,
      ...(message.action === 'finish' ? { error: 'Native acknowledgement failed' }
        : { result: message.action === 'restore' ? ['123'] : [] }),
    } })));
  } };
  if (syncFails) vi.mocked(billingApi.appleSync).mockRejectedValueOnce(new Error('Server verification failed'));
  else vi.mocked(billingApi.appleSync).mockResolvedValue(account);
  await render(<OpenPlansPopup />);
  const initialRefreshes = vi.mocked(billingApi.account).mock.calls.length;
  await click('Restore purchases');
  expect(container.textContent).not.toContain('Native acknowledgement failed');
  if (syncFails) {
    expect(container.textContent).toContain('Server verification failed');
    expect(actions).not.toContain('finish');
    expect(posthog.capture).not.toHaveBeenCalledWith('billing_subscription_confirmed', expect.anything());
  } else {
    expect(actions).toContain('finish');
    expect(vi.mocked(billingApi.account).mock.calls.length).toBeGreaterThan(initialRefreshes);
    expect(posthog.capture).toHaveBeenCalledWith('billing_apple_finish_deferred', { provider: 'apple' });
    expect(posthog.capture).toHaveBeenCalledWith('billing_subscription_confirmed', { provider: 'apple' });
  }
});

it.each([2, 300])('dismisses the plans banner with %s credits and keeps it hidden on rerender', async credits => {
  account = { ...account, credits_remaining: credits, monthly_remaining: credits };
  await render(<CreditNudge />);
  expect(container.querySelector('.credit-nudge')).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss plans banner"]')!.click());
  expect(container.querySelector('.credit-nudge')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('billing_nudge_dismissed', { source: credits === 2 ? 'low_credits' : 'creation_banner', plan_key: 'free' });
  await render(<CreditNudge />);
  expect(container.querySelector('.credit-nudge')).toBeNull();
});

it('updates the same numeric element when the balance loads', async () => {
  let resolveAccount!: (value: BillingAccount) => void;
  vi.mocked(billingApi.account).mockReturnValue(new Promise(resolve => { resolveAccount = resolve; }));
  await render(<CreditBalance />);
  const count = container.querySelector('.credit-count');
  expect(count?.textContent).toBe('…');
  await act(async () => resolveAccount({ ...account, credits_remaining: 12345 }));
  expect(container.querySelector('.credit-count')).toBe(count);
  expect(count?.textContent).toBe('12,345');
});


it.each([0, 2, 12345])('lets the header balance fit %s credits without reserving empty digit space', async credits => {
  account.credits_remaining = credits;
  const style = document.createElement('style');
  style.textContent = readFileSync('src/components/billing.css', 'utf8')
    + readFileSync('src/pages/LandingPage.css', 'utf8');
  document.head.append(style);
  try {
    await render(<header className="landing-header"><CreditBalance /></header>);
    const count = container.querySelector('.credit-count')!;
    expect(count.textContent).toBe(credits.toLocaleString());
    expect(getComputedStyle(count).minWidth).toBe('0');
    expect(getComputedStyle(count).fontVariantNumeric).toBe('tabular-nums');
  } finally { style.remove(); }
});


it.each(['builder', 'creator'] as const)('buys a custom dollar amount at the %s rate', async plan => {
  account = { ...account, plan_key: plan, has_subscription: true, paid_features: true, subscription_status: 'active' };
  vi.mocked(billingApi.creditCheckout).mockResolvedValue({url:'https://checkout.stripe.com/c/pay/pack'});
  await render(<OpenPlansPopup />);
  const input = container.querySelector<HTMLInputElement>('#credit-packs input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '10.00');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelector('#credit-packs output')?.textContent).toBe(plan === 'builder' ? '753 credits' : '751 credits');
  await click('Buy credits');
  expect(billingApi.creditCheckout).toHaveBeenCalledWith(1000);
  expect(billingApi.checkout).not.toHaveBeenCalled();
  expect(openStripe).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/pack');
});

it.each([true, false])('requires a paid monthly plan before buying credits (signed in: %s)', async signedIn => {
  if (!signedIn) auth.user = null;
  await render(<OpenPlansPopup />);
  expect(container.querySelector('#credit-packs h2')?.textContent).toBe('Buy credits');
  expect(container.querySelector('.billing-plan-grid')?.compareDocumentPosition(container.querySelector('#credit-packs')!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  await click('Buy credits');
  const dialog = container.querySelector('#credit-packs dialog')!;
  expect(dialog.textContent).toContain('You must be subscribed to a paid monthly plan to buy credits.');
  expect(dialog.getAttribute('open')).not.toBeNull();
  expect(billingApi.creditCheckout).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('billing_credit_subscription_required', { source: 'pricing_button' });
});

it('shows earned referral credits with their own history label', async () => {
  account = { ...account, apple_remaining: 300, credits_remaining: 302,
    history: [{ id: 1, kind: 'referral', amount: 300, bucket: 'apple', created_at: '2026-10-29T12:00:00Z' }] };
  await render(<BillingPage />);
  expect(container.textContent).not.toContain('Purchased & earned credits · never expire');
  expect(container.querySelector('.billing-big-balance')?.textContent).toContain('302');
  const row = container.querySelector('tbody tr')!;
  expect(row.textContent).toContain('Account referral reward');
  expect(row.textContent).toContain('Referral credits');
  expect(row.textContent).toContain('+300');
  expect(row.textContent).not.toContain('Purchased credits');
});

it('includes member savings on paid plans and marks the Free benefit unavailable', async () => {
  await render(<PlanGrid source="pricing_page" />);
  for (const name of ['Builder', 'Creator']) {
    const plan = container.querySelector(`[aria-label="${name} plan"]`)!;
    const benefit = plan.querySelector('.billing-feature-saving')!;
    expect(benefit.textContent).toContain('20% off every LEGO® set purchase');
    expect(benefit.querySelector('[aria-label="Included"]')).not.toBeNull();
    expect(plan.lastElementChild?.classList.contains('billing-plan-button')).toBe(true);
  }
  const free = container.querySelector('[aria-label="Free plan"]')!;
  const benefit = [...free.querySelectorAll('li')].find(li => li.textContent?.includes('20% off'))!;
  expect(benefit.querySelector('[aria-label="Not included"]')).not.toBeNull();
});

it('keeps the bold member discount and promo details at the top of the shared popup', async () => {
  await render(<OpenPlansPopup />);
  expect(container.querySelector('.billing-member-intro strong')?.textContent).toBe('20% off LEGO® set purchases!');
  expect(container.querySelector('.billing-member-intro')?.textContent).toContain('Applied automatically at checkout, with promo codes on top.');
  expect(container.querySelector('.billing-dialog')?.textContent).not.toContain('Physical model bricks · promo codes stack');
  expect(container.querySelector('.billing-dialog')?.textContent).not.toMatch(/models?/i);
  expect(container.querySelectorAll('.billing-dialog .billing-plan-description, .billing-dialog .billing-renewal')).toHaveLength(0);
  expect([...container.querySelectorAll('.billing-dialog .billing-plan-button')].map(button => button.textContent)).toEqual(['Select Plan', 'Select Plan']);
});
