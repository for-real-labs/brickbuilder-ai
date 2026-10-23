import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { BillingProvider, useBilling } from '../src/contexts/BillingContext';
import { BillingOverlays } from '../src/components/BillingComponents';
import { InstructionsAccessGate } from '../src/components/PaidFeatureDialog';
import { InstructionsPostcard } from '../src/components/checkout/InstructionsPostcard';
import { LandingToolsMenu, type LandingToolsHandle } from '../src/components/LandingToolsMenu';
import { LandingModelWorkspace } from '../src/components/LandingModelWorkspace';
import { InstructionsPage } from '../src/pages/InstructionsPage';
import BillingPage from '../src/pages/BillingPage';
import { OrderCard } from '../src/pages/UserDashboard';
import type { GenerationWithOrder } from '../src/services/getUserGenerationsApi';
import { billingApi, INITIAL_PLANS, type BillingAccount } from '../src/services/billingApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import type { LandingModel } from '../src/hooks/useLandingModel';
import * as modelExport from '../src/utils/modelExport';

const auth = vi.hoisted(() => ({ user: { id: 'member' } as { id: string } | null, isSupabaseConfigured: true }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/contexts/PetContext', () => ({ usePet: () => ({ pet: { id: 'pip', name: 'Pip' }, openPicker: vi.fn() }) }));
vi.mock('../src/contexts/GenerationNotificationsContext', () => ({ useGenerationNotifications: () => ({ markViewed: vi.fn() }) }));
vi.mock('../src/components/PetCompanion', () => ({ PetAvatar: () => <span data-pet="pip" />, PetSwitchButton: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/LandingModelOrdering', () => ({ LandingModelOrdering: () => null }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: () => <div data-model-preview /> }));
vi.mock('../src/components/MpdImageRenderer', () => ({ MpdImageRenderer: () => null }));
vi.mock('../src/components/LoginModal', () => ({ default: ({ open }: { open: boolean }) => open ? <div>Sign in to build</div> : null }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/billingApi', async original => ({ ...await original<typeof import('../src/services/billingApi')>(),
  billingApi: { plans: vi.fn(), account: vi.fn(), checkout: vi.fn(), portal: vi.fn(), sync: vi.fn() }, openStripe: vi.fn(),
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let account: BillingAccount;
const model = { content: 'model', generation: { generation_id: 'castle', endpoint: 'novaToBricks', name: 'Castle' } } as LandingModel;
const toolRef = React.createRef<LandingToolsHandle>();
const render = (children: React.ReactNode, path = '/') => act(async () => root.render(<MemoryRouter initialEntries={[path]}><BillingProvider>{children}<BillingOverlays /></BillingProvider></MemoryRouter>));
const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.startsWith(text))!;
const click = (text: string) => act(async () => { expect(button(text), text).toBeDefined(); button(text).click(); });
const tools = () => <LandingToolsMenu ref={toolRef} page="/" model={model} />;

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks(); auth.user = { id: 'member' };
  account = { plan_key: 'free', paid_features: false, monthly_credits: 300, monthly_remaining: 300, credits_remaining: 300, bonus_remaining: 0,
    period_start: '2026-10-01T00:00:00Z', period_end: '2099-11-01T00:00:00Z', subscription_status: 'none', cancel_at_period_end: false, has_subscription: false, enabled: true, history: [] };
  vi.mocked(billingApi.plans).mockResolvedValue({ plans: INITIAL_PLANS, enabled: true, ready: true });
  vi.mocked(billingApi.account).mockImplementation(async () => account);
  vi.mocked(billingApi.sync).mockImplementation(async () => account);
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => { act(() => root.unmount()); host.remove(); sessionStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([['ldraw','Download LDraw'],['io','Download IO']] as const)('locks %s exports, opens the shared notice and offers only Builder/Creator upgrades', async (feature, label) => {
  const download = vi.spyOn(modelExport, 'downloadModel').mockImplementation(() => {});
  await render(tools()); await click('Tools'); await click('Export');
  expect(button(label).disabled).toBe(false);
  expect(button(label).querySelector('.paid-feature-lock')).not.toBeNull();
  await click(label);
  expect(download).not.toHaveBeenCalled();
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('not available on the Free plan');
  expect(document.body.style.overflow).toBe('hidden');
  expect(posthog.capture).toHaveBeenCalledWith('billing_feature_blocked', { feature, source: 'tools_dropdown', access: 'locked' });
  await click('Upgrade plan');
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
  expect(host.querySelectorAll('.billing-plan')).toHaveLength(2);
  expect(host.textContent).toContain('Choose Builder'); expect(host.textContent).toContain('Choose Creator');
  expect(host.textContent).not.toContain('Master Builder');
});

it('keeps locked exports clickable even before a model is loaded and lets Escape dismiss the notice', async () => {
  await render(<LandingToolsMenu page="/" />); await click('Tools'); await click('Export'); await click('Download IO');
  expect(host.querySelector('.billing-feature-dialog')).not.toBeNull();
  await act(async () => host.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(host.querySelector('dialog')).toBeNull(); expect(document.body.style.overflow).toBe('');
});

it('keeps CSV exports available on Free and blocks the buddy LDR shortcut', async () => {
  const download = vi.spyOn(modelExport, 'downloadModel').mockImplementation(() => {});
  await render(tools()); await click('Tools'); await click('Export'); await click('Download parts list CSV');
  expect(download).toHaveBeenCalledExactlyOnceWith('model','Castle','csv');
  let reply = ''; await act(async () => { reply = toolRef.current!.runTool('export_ldraw','castle'); });
  expect(reply).toContain('require a paid plan'); expect(download).toHaveBeenCalledTimes(1);
  expect(host.querySelector('.billing-feature-dialog')).not.toBeNull();
});

it.each(['builder','creator','master'] as const)('allows %s exports even with no remaining credits and scheduled cancellation', async plan => {
  account = { ...account, plan_key: plan, paid_features: true, subscription_status: 'active', has_subscription: true, cancel_at_period_end: true, credits_remaining: 0 };
  const download = vi.spyOn(modelExport, 'downloadModel').mockImplementation(() => {});
  await render(tools()); await click('Tools'); await click('Export');
  expect(button('Download IO').querySelector('.paid-feature-lock')).toBeNull();
  await click('Download IO'); expect(download).toHaveBeenCalledExactlyOnceWith('model','Castle','io');
});

it.each([false,true])('keeps Free instruction controls visible and blocks embedded viewing (deep link: %s)', async deepLink => {
  const read = vi.spyOn(NovaToBricksApiService,'instructions').mockResolvedValue('steps');
  await render(<LandingModelWorkspace model={model} busy={false} requestedInstructionsId={deepLink ? 'castle' : null}>Chat</LandingModelWorkspace>);
  expect(button('Show instructions').querySelector('.paid-feature-lock')).not.toBeNull();
  if (!deepLink) await click('Show instructions');
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('building instructions');
  expect(host.querySelector('[data-model-preview]')).not.toBeNull();
  expect(host.querySelector('.landing-instructions-view')).toBeNull(); read.mockRestore();
});

it('blocks direct instruction URLs before loading model content', async () => {
  const read = vi.spyOn(GetGenerationApiService,'getGeneration').mockRejectedValue(new Error('must not load'));
  await render(<InstructionsPage />, '/instructions?id=castle');
  expect(host.querySelector('[aria-label="Building instructions locked"]')).not.toBeNull();
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('Instructions are included with kits you order.');
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('Open the link in your order email');
  expect(read).not.toHaveBeenCalled();
});

it('keeps the postcard preview available underneath its upgrade notice and restores scrolling when both close', async () => {
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false; this.dispatchEvent(new Event('close')); } });
  await render(<InstructionsPostcard selected={false} onChange={() => {}} disabled={false} modelName="Castle" modelImage={null} generationId="castle" />);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="About the instructions post card"]')!.click());
  await act(async () => host.querySelector<HTMLAnchorElement>('.checkout-postcard-qr')!.click());
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('Instructions are included with kits you order.');
  expect(host.querySelectorAll('dialog[open]')).toHaveLength(2);
  expect(document.body.style.overflow).toBe('hidden');
  await click('Not now');
  expect(host.querySelector<HTMLDialogElement>('.checkout-postcard-dialog')!.open).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  await click('Got it'); expect(document.body.style.overflow).toBe('');
});

it('locks guest access and unmounts open instructions immediately after logout', async () => {
  account = { ...account, plan_key: 'builder', paid_features: true, subscription_status: 'active', has_subscription: true };
  const content = <InstructionsAccessGate><div data-private-steps>Steps</div></InstructionsAccessGate>;
  await render(content); expect(host.querySelector('[data-private-steps]')).not.toBeNull();
  auth.user = null; await render(content);
  expect(host.querySelector('[data-private-steps]')).toBeNull();
  expect(host.querySelector('.billing-feature-dialog')).not.toBeNull();
  await click('Upgrade plan'); await click('Choose Builder');
  expect(host.textContent).toContain('Sign in to build'); expect(billingApi.checkout).not.toHaveBeenCalled();
});

it('does not unlock while billing loads or fails and supports retry without suggesting an unnecessary upgrade', async () => {
  let resolvePlans!: (value: Awaited<ReturnType<typeof billingApi.plans>>) => void;
  vi.mocked(billingApi.plans).mockImplementationOnce(() => new Promise(resolve => { resolvePlans = resolve; }));
  const download = vi.spyOn(modelExport,'downloadModel').mockImplementation(() => {});
  await render(tools()); await click('Tools'); await click('Export'); await click('Download IO');
  expect(host.textContent).toContain('Checking your access'); expect(button('Upgrade plan')).toBeUndefined();
  await act(async () => resolvePlans({ plans: INITIAL_PLANS, enabled: false, ready: false }));
  expect(host.textContent).toContain('Couldn’t check your access'); expect(button('Upgrade plan')).toBeUndefined();
  await click('Try again'); expect(host.textContent).toContain('not available on the Free plan');
  expect(download).not.toHaveBeenCalled();
});

it('does not carry paid access across identities or an expired paid period', async () => {
  account = { ...account, plan_key: 'creator', paid_features: true, subscription_status: 'active', has_subscription: true };
  const seen: string[] = [];
  function Access() { const { featureAccess } = useBilling(); seen.push(featureAccess); return <div>{featureAccess}</div>; }
  await render(<Access />); expect(seen.at(-1)).toBe('allowed');
  seen.length = 0; auth.user = { id: 'other' };
  account = { ...account, paid_features: true, period_end: '2000-01-01T00:00:00Z' };
  await render(<Access />); expect(seen).not.toContain('allowed'); expect(seen.at(-1)).toBe('locked');
});

it('preserves an existing Master subscription label and cancellation without offering it for sale', async () => {
  account = { ...account, plan_key: 'master', paid_features: true, subscription_status: 'active', has_subscription: true, monthly_credits: 1000 };
  await render(<BillingPage />);
  expect(host.querySelector('.billing-account-plan')?.textContent).toContain('Master Builder$39 / month');
  expect(button('Cancel subscription')).toBeDefined();
  await click('Explore plans'); expect(button('Choose Master Builder')).toBeUndefined();
});

it.each(['free', 'builder'] as const)('allows purchased model instructions on %s after the credit or subscription period expires', async plan => {
  account = { ...account, plan_key: plan, paid_features: false, period_end: '2000-01-01T00:00:00Z',
    subscription_status: 'canceled', credits_remaining: 0, ordered_instruction_models: ['castle'] };
  await render(<><InstructionsAccessGate generationId="castle"><div data-ordered-steps>Purchased instructions</div></InstructionsAccessGate>{tools()}</>);
  expect(host.querySelector('[data-ordered-steps]')).not.toBeNull();
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
  await click('Tools'); await click('Export'); await click('Download IO');
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('IO export is a paid feature');
});

it('does not inherit order access when switching models, accounts, or signing out', async () => {
  account.ordered_instruction_models = ['castle'];
  const content = (id: string) => <InstructionsAccessGate generationId={id}><div data-ordered-steps /></InstructionsAccessGate>;
  await render(content('castle')); expect(host.querySelector('[data-ordered-steps]')).not.toBeNull();
  await render(content('castle-edit')); expect(host.querySelector('[data-ordered-steps]')).toBeNull();
  await render(content('castle')); expect(host.querySelector('[data-ordered-steps]')).not.toBeNull();
  // The next account is still loading: no frame may retain the first account's access.
  const seen: string[] = [];
  function Access() { const { getFeatureAccess } = useBilling(); seen.push(getFeatureAccess('instructions', 'castle')); return content('castle'); }
  auth.user = { id: 'other' };
  vi.mocked(billingApi.account).mockImplementationOnce(() => new Promise(() => {}));
  await render(<Access />);
  expect(seen).not.toContain('allowed'); expect(host.querySelector('[data-ordered-steps]')).toBeNull();
  auth.user = null; await render(content('castle'));
  expect(host.querySelector('[data-ordered-steps]')).toBeNull();
});

it('refreshes a newly recorded order and closes its obsolete upgrade notice', async () => {
  const content = <InstructionsAccessGate generationId="castle"><div data-ordered-steps /></InstructionsAccessGate>;
  await render(content); expect(host.querySelector('.billing-feature-dialog')).not.toBeNull();
  account = { ...account, ordered_instruction_models: ['castle'] };
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.querySelector('[data-ordered-steps]')).not.toBeNull();
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
});

it.each([false, true])('opens purchased instructions from the model workspace without an upgrade (deep link: %s)', async deepLink => {
  account.ordered_instruction_models = ['castle'];
  const read = vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(() => new Promise(() => {}));
  await render(<LandingModelWorkspace model={model} busy={false} requestedInstructionsId={deepLink ? 'castle' : null}>Chat</LandingModelWorkspace>);
  if (!deepLink) {
    expect(button('Show instructions').querySelector('.paid-feature-lock')).toBeNull();
    await click('Show instructions');
  }
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
  expect(host.querySelector('.landing-instructions-view')).not.toBeNull();
  expect(read).toHaveBeenCalledWith('castle');
});

it('loads purchased instructions through a direct URL', async () => {
  account.ordered_instruction_models = ['castle'];
  const read = vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(() => new Promise(() => {}));
  await render(<InstructionsPage />, '/instructions?id=castle');
  expect(read).toHaveBeenCalledExactlyOnceWith('castle');
  expect(host.querySelector('[aria-label="Building instructions locked"]')).toBeNull();
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
});

it('unlocks the purchased model on the dashboard and postcard preview', async () => {
  account.ordered_instruction_models = ['castle'];
  const generation = { id: 'castle', prompt: 'Castle', created_at: '2026-10-01',
    order: { id: 1, generation_id: 'castle', fulfilled: true } } as GenerationWithOrder;
  await render(<><OrderCard g={generation} onView={() => {}} />
    <InstructionsPostcard selected={false} onChange={() => {}} disabled={false} modelName="Castle" modelImage={null} generationId="castle" /></>);
  const link = host.querySelector<HTMLAnchorElement>('a[href="/instructions?id=castle"]')!;
  expect(link.querySelector('.paid-feature-lock')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="About the instructions post card"]')!.click());
  const qr = host.querySelector<HTMLAnchorElement>('.checkout-postcard-qr')!;
  expect(qr.getAttribute('aria-label')).toBe('Open instructions for Castle');
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => qr.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
});

it('validates a guest link before mounting instructions and never unlocks exports or another model', async () => {
  const id = '00000000-0000-4000-8000-000000000001', key = 'a'.repeat(43);
  auth.user = null;
  sessionStorage.setItem(`brickbuilder:instruction-key:${id}`, key);
  let complete!: (allowed: boolean) => void;
  const verify = vi.spyOn(NovaToBricksApiService, 'instructionAccess').mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  const content = <><InstructionsAccessGate generationId={id}><div data-guest-steps /></InstructionsAccessGate>{tools()}</>;
  await render(content);
  expect(host.querySelector('[data-guest-steps]')).toBeNull();
  expect(host.textContent).toContain('Checking your access');
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
  await act(async () => complete(true));
  expect(host.querySelector('[data-guest-steps]')).not.toBeNull();
  expect(verify).toHaveBeenCalledExactlyOnceWith(id, key);
  expect(billingApi.account).not.toHaveBeenCalled();
  await click('Tools'); await click('Export'); await click('Download IO');
  expect(host.querySelector('.billing-feature-dialog')?.textContent).toContain('IO export is a paid feature');
  await render(<InstructionsAccessGate generationId="other"><div data-guest-steps /></InstructionsAccessGate>);
  expect(host.querySelector('[data-guest-steps]')).toBeNull();
});

it('removes guest access after revocation and explains invalid links without an upgrade prompt', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  auth.user = null; sessionStorage.setItem(`brickbuilder:instruction-key:${id}`, 'a'.repeat(43));
  const verify = vi.spyOn(NovaToBricksApiService, 'instructionAccess').mockResolvedValue(true);
  await render(<InstructionsAccessGate generationId={id}><div data-guest-steps /></InstructionsAccessGate>);
  expect(host.querySelector('[data-guest-steps]')).not.toBeNull();
  verify.mockResolvedValue(false);
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(host.querySelector('[data-guest-steps]')).toBeNull();
  expect(host.textContent).toContain('This instruction link couldn’t be verified');
  expect(host.querySelector('.billing-feature-dialog')).toBeNull();
});
