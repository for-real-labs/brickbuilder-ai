import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { LandingToolsMenu } from '../src/components/LandingToolsMenu';
import { authenticatedApiFetch } from '../src/services/apiFetch';
import { sendSupport } from '../src/services/supportApi';
import type { LandingModel } from '../src/hooks/useLandingModel';

const auth = vi.hoisted(() => ({ user: null as { id: string; email: string } | null, loading: false }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/components/PetCompanion', () => ({ PetSwitchButton: () => <button>Build Buddy</button> }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const model = { content: 'model', generation: { generation_id: '538e9a91-54c9-4fea-850e-49f531ed46cd' } } as LandingModel;
const button = (label: string) => [...host.querySelectorAll('button')].find(node => node.textContent === label)!;
const send = () => act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
const fill = (selector: string, value: string) => act(() => {
  const field = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
  Object.getOwnPropertyDescriptor(field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
const body = (index = 0) => JSON.parse(vi.mocked(authenticatedApiFetch).mock.calls[index][1]!.body as string);
const mount = (selected: LandingModel | null = model) => act(() => root.render(<MemoryRouter><LandingToolsMenu page="/" model={selected} /></MemoryRouter>));
const open = () => { act(() => button('Tools').click()); act(() => button('Support').click()); };
beforeEach(() => {
  vi.clearAllMocks(); auth.user = null; auth.loading = false;
  vi.mocked(authenticatedApiFetch).mockImplementation(async () => new Response(JSON.stringify({ sent: true })));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function() { this.open = false; this.dispatchEvent(new Event('close')); } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });

it('opens Support last in Tools with concise copy, email fields and a direct email link', () => {
  mount(); act(() => button('Tools').click());
  expect(host.querySelector('ul[aria-label="Tools"] > li:last-child')?.textContent).toBe('Support');
  act(() => button('Support').click());
  expect(host.querySelector('dialog')?.open).toBe(true);
  expect(host.querySelector('ul[aria-label="Tools"]')).toBeNull();
  expect(host.textContent).toContain('Send here or email support@brickbuilder.ai.');
  expect(host.querySelector('a[href="mailto:support@brickbuilder.ai"]')).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type=email]')?.required).toBe(true);
  expect(button('Send').disabled).toBe(true);
  expect(document.body.style.overflow).toBe('hidden');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Close support"]')!.click());
  expect(document.activeElement).toBe(button('Tools'));
  expect(document.body.style.overflow).not.toBe('hidden');
});

it.each([true, false])('sends contact email and current generation without trusting client user IDs (signed in: %s)', async signedIn => {
  if (signedIn) auth.user = { id: 'account-id', email: 'account@example.com' };
  mount(); open();
  expect(host.querySelector<HTMLInputElement>('input')!.value).toBe(signedIn ? 'account@example.com' : '');
  fill('input', 'reply@example.com'); fill('textarea', '  My model disappeared.  ');
  await send();
  expect(body()).toEqual({ email: 'reply@example.com', message: 'My model disappeared.', generation_id: model.generation.generation_id, request_id: expect.any(String) });
  expect(authenticatedApiFetch).toHaveBeenCalledWith(expect.stringContaining('/support-email'), expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) }));
  expect(host.textContent).toContain('Message sent.');
  expect(posthog.capture).toHaveBeenCalledWith('support_sent', { is_authenticated: signedIn, has_generation: true });
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('reply@example.com');
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('My model disappeared');
});

it('omits the current generation so the backend can select the user’s latest three', async () => {
  mount(null); open(); fill('input', 'guest@example.com'); fill('textarea', 'Help please'); await send();
  expect(body()).not.toHaveProperty('generation_id');
  expect(body()).not.toHaveProperty('user_id');
});

it('preserves the draft and retry ID on failure, and uses a new ID when the draft changes', async () => {
  vi.mocked(authenticatedApiFetch).mockImplementation(async () => new Response('{}', { status: 503 }));
  mount(); open(); fill('input', 'guest@example.com'); fill('textarea', 'Help please'); await send();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('Could not send');
  expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Help please');
  expect(button('Send').disabled).toBe(false);
  await send(); expect(body(0).request_id).toBe(body(1).request_id);
  fill('textarea', 'Updated message'); await send();
  expect(body(2).request_id).not.toBe(body(1).request_id);
  vi.mocked(authenticatedApiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ sent: true })));
  await send(); expect(host.textContent).toContain('Message sent.');
});

it('prevents duplicates while sending, including closing and reopening', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(authenticatedApiFetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  mount(); open(); fill('input', 'guest@example.com'); fill('textarea', 'Help'); await send(); await send();
  expect(button('Sending…').disabled).toBe(true);
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Close support"]')!.click());
  open(); await send(); expect(authenticatedApiFetch).toHaveBeenCalledTimes(1);
  await act(async () => finish(new Response(JSON.stringify({ sent: true }))));
  expect(host.textContent).toContain('Message sent.');
});

it.each([[401, 'Sign in again'], [422, 'Check your email'], [429, 'Wait a minute'], [500, 'Could not send']])('handles HTTP %s without exposing provider details', async (status, message) => {
  vi.mocked(authenticatedApiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'internal credentials' }), { status: status as number }));
  await expect(sendSupport({ email: 'guest@example.com', message: 'Help', requestId: crypto.randomUUID() })).rejects.toThrow(message as string);
});

it('rejects invalid input, network failures and unconfirmed success', async () => {
  const payload = { email: 'guest@example.com', message: 'Help', requestId: crypto.randomUUID() };
  await expect(sendSupport({ ...payload, email: 'invalid' })).rejects.toThrow('valid email');
  await expect(sendSupport({ ...payload, message: ' ' })).rejects.toThrow('Enter a message');
  await expect(sendSupport({ ...payload, message: 'x'.repeat(5001) })).rejects.toThrow('5,000');
  expect(authenticatedApiFetch).not.toHaveBeenCalled();
  vi.mocked(authenticatedApiFetch).mockRejectedValueOnce(new Error('network private details'));
  await expect(sendSupport(payload)).rejects.toThrow('Could not send');
  vi.mocked(authenticatedApiFetch).mockResolvedValueOnce(new Response('{}'));
  await expect(sendSupport(payload)).rejects.toThrow('Could not send');
});

it('aborts a slow request and provides a retryable timeout error', async () => {
  vi.useFakeTimers();
  vi.mocked(authenticatedApiFetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  const result = expect(sendSupport({ email: 'guest@example.com', message: 'Help', requestId: crypto.randomUUID() })).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(25_000); await result;
});
