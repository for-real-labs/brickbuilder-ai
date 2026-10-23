import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { BillingProvider } from '../src/contexts/BillingContext';
import { BillingOverlays, CreditBalance, CreditNudge, PlanGrid, GenerationCreditQuote } from '../src/components/BillingComponents';
import BillingPage from '../src/pages/BillingPage';
import PricingPage from '../src/pages/PricingPage';
import { billingApi, openStripe, type BillingAccount } from '../src/services/billingApi';

const auth = vi.hoisted(() => ({ user: { id: 'builder-1' } as { id: string } | null }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/contexts/PetContext', () => ({ usePet: () => ({ pet: { name: 'Pip', id: 'pip' } }) }));
vi.mock('../src/components/PetCompanion', () => ({ PetAvatar: ({ id = 'pip' }) => <span data-pet={id} /> }));
vi.mock('../src/components/LoginModal', () => ({ default: ({ open }: { open: boolean }) => open ? <div role="dialog">Sign in to build</div> : null }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/billingApi', async importOriginal => ({ ...await importOriginal<typeof import('../src/services/billingApi')>(),
  billingApi: { plans: vi.fn(), account: vi.fn(), checkout: vi.fn(), portal: vi.fn(), sync: vi.fn() }, openStripe: vi.fn(),
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let account: BillingAccount;
const render = async (children: React.ReactNode) => act(async () => root.render(<HelmetProvider><MemoryRouter><BillingProvider>{children}<BillingOverlays /></BillingProvider></MemoryRouter></HelmetProvider>));
const click = async (text: string) => act(async () => {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  expect(button, text).toBeDefined(); button!.click();
});

beforeEach(async () => {
  vi.clearAllMocks();
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
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('opens the balance upgrade flow, displays monthly terms, and starts the selected plan', async () => {
  await render(<CreditBalance />);
  expect(container.querySelector('button')?.getAttribute('aria-label')).toContain('2 credits');
  await click('credits');
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(container.querySelectorAll('.billing-plan')).toHaveLength(2);
  expect(container.textContent).toContain('Monthly credits reset and do not roll over');
  await click('Choose Creator');
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
  expect(container.querySelector('[aria-label="Free plan"]')?.textContent).toContain('Instructions included with ordered kits');
  await click('Choose Builder');
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

it('directs an exhausted highest-tier subscriber to usage instead of promising more credits', async () => {
  account = { ...account, plan_key: 'master', has_subscription: true, subscription_status: 'active', credits_remaining: 0, monthly_remaining: 0, monthly_credits: 1000 };
  await render(<CreditNudge />);
  expect(container.textContent).toContain('View usage');
  expect(container.textContent).not.toContain('Get more credits');
  await click('View usage');
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
  await render(<PricingPage />);
  await click('Choose Creator');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please try again in a moment.');
  expect(openStripe).not.toHaveBeenCalled();
  expect(container.textContent).toContain('monthly plans only');
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
  await render(<PricingPage />);
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Monthly plans are coming soon');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect([...container.querySelectorAll('button')].find(b => b.textContent === 'Choose Builder')?.disabled).toBe(false);
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


it('shows the approved monthly allowances and whole All parts equivalents on every plan', async () => {
  await render(<PricingPage />);
  const cards = [...container.querySelectorAll('.billing-plan')];
  expect(cards.map(card => card.querySelector('.billing-price strong')?.textContent)).toEqual(['$0', '$9', '$19']);
  ['300 Basic builds or 20 All parts builds', '500 Basic builds or 33 All parts builds',
    '750 Basic builds or 50 All parts builds']
    .forEach((allowance, index) => expect(cards[index].textContent).toContain(allowance));
  expect(container.textContent).toContain('leftover credits remain usable for Basic builds');
  expect(container.textContent).toContain('up to 5 bonus credits per calendar month');
});

it.each([false,true])('explains guest access without requiring login and offers optional signup (All parts: %s)', async allParts => {
  auth.user = null;
  await render(<GenerationCreditQuote allParts={allParts} />);
  expect(container.textContent).toContain(allParts ? '15 credits' : '1 credit');
  expect(container.textContent).toContain('75 lifetime guest credits: 5 All parts builds or 75 Basic builds, or a mix. No login needed.');
  expect(container.textContent).not.toContain('One guest trial');
  await click('Sign in for 300 free monthly credits');
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

it('separates preserved bonus balance from the bonus credits usable this month', async () => {
  account = { ...account, bonus_remaining: 100, bonus_available: 3, credits_remaining: 5 };
  await render(<BillingPage />);
  expect(container.textContent).toContain('Legacy bonus balance');
  expect(container.textContent).toContain('3 bonus credits available for Basic builds');
});


it('does not imply that legacy bonuses can fund an All parts build', async () => {
  account = { ...account, plan_key: 'builder', has_subscription: true, subscription_status: 'active',
    monthly_credits: 500, monthly_remaining: 10, bonus_remaining: 100, bonus_available: 5, credits_remaining: 15 };
  await render(<><GenerationCreditQuote allParts /><CreditNudge /></>);
  expect(container.textContent).toContain('10 monthly credits available. Legacy bonuses are for Basic only.');
  expect(container.querySelector('.credit-nudge--low')).not.toBeNull();
});
