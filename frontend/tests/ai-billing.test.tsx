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
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let settings: Settings;
const click = async (label: string) => act(async () => { const b = [...container.querySelectorAll('button')].find(b => b.textContent === label); expect(b).toBeDefined(); b!.click(); });
beforeEach(() => {
  settings = { billing_source: 'personal', skip_confirmation: false, providers: ['openai'] };
  vi.spyOn(providerKeysApi, 'status').mockImplementation(async () => settings);
  vi.spyOn(providerKeysApi, 'preferences').mockImplementation(async value => ({ ...settings, ...value }));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

it('asks before generation and cancels without submitting or switching to platform credits', async () => {
  await act(async () => root.render(<AiBillingPrompt />));
  let result: Promise<string>;
  await act(async () => { result = prepareAiBilling(JSON.stringify({ model: 'gpt-5.5', prompt: 'castle' })); void result.catch(() => {}); });
  expect(container.textContent).toContain('using your own AI billing');
  await click('No');
  await expect(result!).rejects.toThrow('Generation cancelled');
  expect(providerKeysApi.preferences).not.toHaveBeenCalled();
});

it('continues and persists dont-ask-again only when explicitly chosen', async () => {
  await act(async () => root.render(<AiBillingPrompt />));
  let result: Promise<string>;
  await act(async () => { result = prepareAiBilling(JSON.stringify({ model: 'gpt-5.5' })); });
  await click('Continue & don’t ask again');
  expect(providerKeysApi.preferences).toHaveBeenCalledWith({ billing_source: 'personal', skip_confirmation: true });
  expect(JSON.parse(await result!)).toMatchObject({ billing_source: 'personal' });
});

it('honors saved confirmation preference and rejects missing provider keys without fallback', async () => {
  settings.skip_confirmation = true;
  expect(JSON.parse(await prepareAiBilling('{"model":"gpt-5.5"}')).billing_source).toBe('personal');
  await expect(prepareAiBilling('{"model":"claude-opus-5-5"}')).rejects.toThrow('Add your Claude API key');
  settings.billing_source = 'brickbuilder';
  expect(JSON.parse(await prepareAiBilling('{"model":"claude-opus-5-5"}')).billing_source).toBe('brickbuilder');
});

it('offers keys after credit exhaustion and opens the secure entry form', async () => {
  await act(async () => root.render(<AiBillingPrompt />));
  await act(async () => window.dispatchEvent(new Event('brickbuilder:credits-required')));
  expect(container.textContent).toContain('out of BrickBuilder credits');
  expect(container.textContent).toContain('no BrickBuilder credit limit');
  await click('Yes, add API keys');
  expect(container.querySelectorAll('input[type=password]')).toHaveLength(2);
});

it('clears saved key inputs and never captures key values in analytics or browser storage', async () => {
  const save = vi.spyOn(providerKeysApi, 'save').mockResolvedValue(settings);
  await act(async () => root.render(<AiBillingSettings />));
  expect(container.textContent).toContain('Use your own OpenAI or Claude API key to use BrickBuilder for free.');
  const input = container.querySelector<HTMLInputElement>('input[type=password]')!;
  const secret = 'sk-test-only-private-key';
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input,secret); input.dispatchEvent(new Event('input',{bubbles:true})); });
  await click('Save key');
  expect(save).toHaveBeenCalledWith('openai',secret);
  expect(input.value).toBe('');
  expect(input.classList.contains('ph-no-capture')).toBe(true);
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain(secret);
  expect(JSON.stringify(localStorage)).not.toContain(secret);
});

it('fails closed when settings cannot be read', async () => {
  vi.mocked(providerKeysApi.status).mockRejectedValue(new Error('Unavailable'));
  await expect(prepareAiBilling('{"model":"gpt-5.5"}')).rejects.toThrow('Unavailable');
});
