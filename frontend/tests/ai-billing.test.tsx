import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { AiBillingPrompt } from '../src/components/AiBillingPrompt';
import { AiBillingSettings } from '../src/components/AiBillingSettings';
import { prepareAiBilling, providerKeysApi, type AiBillingSettings as Settings } from '../src/services/providerKeysApi';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'alice' } }) }));
vi.mock('../src/components/PetCompanion', () => ({ PetChatMessage: ({ children }: { children: React.ReactNode }) => <div data-pet-message>{children}</div> }));
const navigate = vi.hoisted(() => vi.fn());
let account: {plan_key: string; has_subscription: boolean} | null = null;
vi.mock('react-router-dom', () => ({useNavigate: () => navigate}));
vi.mock('../src/contexts/BillingContext', () => ({useBilling: () => ({account})}));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let settings: Settings;
const click = async (label: string) => act(async () => { const b = [...container.querySelectorAll('button')].find(b => b.textContent === label); expect(b).toBeDefined(); b!.click(); });
beforeEach(() => {
  account = null;
  settings = { billing_source: 'personal', skip_confirmation: false, providers: ['anthropic'] };
  vi.spyOn(providerKeysApi, 'status').mockImplementation(async () => settings);
  vi.spyOn(providerKeysApi, 'preferences').mockImplementation(async value => ({ ...settings, ...value }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it('asks before generation and cancels without submitting or switching to platform credits', async () => {
  await act(async () => root.render(<AiBillingPrompt />));
  let result: Promise<string>;
  await act(async () => { result = prepareAiBilling(JSON.stringify({ model: 'claude-opus-5-5', prompt: 'castle' })); void result.catch(() => {}); });
  expect(container.textContent).toContain('using your own AI billing');
  await click('No');
  await expect(result!).rejects.toThrow('Generation cancelled');
  expect(providerKeysApi.preferences).not.toHaveBeenCalled();
});

it('continues and persists dont-ask-again only when explicitly chosen', async () => {
  await act(async () => root.render(<AiBillingPrompt />));
  let result: Promise<string>;
  await act(async () => { result = prepareAiBilling(JSON.stringify({ model: 'claude-opus-5-5' })); });
  await click('Continue & don’t ask again');
  expect(providerKeysApi.preferences).toHaveBeenCalledWith({ billing_source: 'personal', skip_confirmation: true });
  expect(JSON.parse(await result!)).toMatchObject({ billing_source: 'personal' });
});

it('honors saved confirmation preference and rejects missing provider keys without fallback', async () => {
  settings.skip_confirmation = true;
  expect(JSON.parse(await prepareAiBilling('{"model":"claude-opus-5-5"}')).billing_source).toBe('personal');
  settings.providers = [];
  await expect(prepareAiBilling('{"model":"claude-opus-5-5"}')).rejects.toThrow('Add your Claude / Anthropic API key');
  settings.billing_source = 'brickbuilder';
  expect(JSON.parse(await prepareAiBilling('{"model":"claude-opus-5-5"}')).billing_source).toBe('brickbuilder');
});

it.each([
  ['free', false, 'See pricing plans', '/pricing'],
  ['builder', true, 'Upgrade plan', '/pricing'],
  ['creator', true, 'Buy more credits', '/billing#credit-packs'],
  ['master', true, 'Buy more credits', '/billing#credit-packs'],
])('routes exhausted %s accounts to the right purchase option', async (plan, paid, label, destination) => {
  account = {plan_key: plan as string, has_subscription: paid as boolean};
  await act(async () => root.render(<AiBillingPrompt />));
  await act(async () => window.dispatchEvent(new Event('brickbuilder:credits-required')));
  expect(container.textContent).toContain('out of BrickBuilder credits');
  expect(container.textContent).not.toContain('API keys');
  await click(label as string);
  expect(navigate).toHaveBeenCalledWith(destination);
});

it('clears saved key inputs and never captures key values in analytics or browser storage', async () => {
  account = { plan_key: 'builder', has_subscription: true };
  const save = vi.spyOn(providerKeysApi, 'save').mockResolvedValue(settings);
  await act(async () => root.render(<AiBillingSettings />));
  expect(container.textContent).toContain('Subscribers can use their own Anthropic API key to generate LEGO® models instead of purchasing BrickBuilder AI credits.');
  const input = container.querySelector<HTMLInputElement>('input[type=password]')!;
  const secret = 'sk-test-only-private-key';
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input,secret); input.dispatchEvent(new Event('input',{bubbles:true})); });
  await click('Save key');
  expect(save).toHaveBeenCalledWith('anthropic',secret);
  expect(input.value).toBe('');
  expect(input.classList.contains('ph-no-capture')).toBe(true);
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain(secret);
  expect(JSON.stringify(localStorage)).not.toContain(secret);
});

it('fails closed when settings cannot be read', async () => {
  vi.mocked(providerKeysApi.status).mockRejectedValue(new Error('Unavailable'));
  settings.providers = [];
  await expect(prepareAiBilling('{"model":"claude-opus-5-5"}')).rejects.toThrow('Unavailable');
});

it('keeps OpenAI builds on BrickBuilder billing without a personal key or confirmation', async () => {
  settings.providers = [];
  expect(JSON.parse(await prepareAiBilling('{"model":"gpt-5.5"}')).billing_source).toBe('brickbuilder');
});

it('shows a subscription popup before a free user can enter an Anthropic key', async () => {
  account = { plan_key: 'free', has_subscription: false };
  await act(async () => root.render(<AiBillingSettings />));
  const details = container.querySelector('details')!;
  expect(details.open).toBe(false);
  expect(container.querySelector('summary')?.textContent).toBe('Use your own AI Accounts');
  expect(container.querySelectorAll('input[type=password]')).toHaveLength(1);
  const input = container.querySelector<HTMLInputElement>('input[type=password]')!;
  act(() => { details.open = true; input.focus(); });
  expect(input.readOnly).toBe(true);
  expect(container.querySelector('dialog')?.open).toBe(true);
  expect(container.textContent).toContain('You must be on a subscription plan to use your own Anthropic key.');
  expect(container.textContent).not.toContain('Image-to-3D services still');
});
