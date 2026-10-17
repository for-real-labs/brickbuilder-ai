import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GetNotifiedButton } from '../src/components/GetNotifiedButton';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { authenticatedApiFetch } from '../src/services/apiFetch';
import posthog from 'posthog-js';

const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string; email?: string } } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: vi.fn() }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
const enterEmail = (email = 'guest@example.com') => act(() => {
  const input = container.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, email);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
beforeEach(() => {
  auth.session = null;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
  vi.spyOn(GenerationEmailApi, 'subscribe').mockResolvedValue({ subscribed: true, email: 'guest@example.com' });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('asks about a 30-minute wait in the conversation and opts in only after a guest supplies an email', async () => {
  const shown = vi.fn();
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart onPromptShown={shown} />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  expect(container.textContent).toContain('up to 30 minutes');
  expect(container.textContent).toContain('Want an email');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  expect(shown).toHaveBeenCalledOnce();
  await click('Yes, email me');
  expect(container.querySelector('.pet-chat-message--user')?.textContent).toContain('Yes, email me.');
  expect(container.textContent).toContain('What email should I use?');
  enterEmail();
  await click('Notify me');
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('build', 'guest@example.com');
  expect(container.textContent).toContain('I’ll email guest@example.com when your build is ready.');
  expect(container.querySelector('input')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('generation_email_notification_subscribed', expect.objectContaining({ source: 'build_buddy_chat' }));
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('guest@example.com');
});

it('declines without a request, keeps the dialogue, and permits a later opt-in', async () => {
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  await click('Not now');
  expect(container.querySelector('.pet-chat-message--user')?.textContent).toContain('Not now.');
  expect(container.textContent).toContain('I’ll keep building');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  expect(button('Yes, email me')).toBeUndefined();
  await click('Get notified');
  expect(button('Yes, email me')).toBeDefined();
});

it('subscribes signed-in users with the server-side account address after their explicit yes', async () => {
  auth.session = { user: { id: 'owner', email: 'account@example.com' } };
  vi.mocked(GenerationEmailApi.subscribe).mockResolvedValue({ subscribed: true, email: 'account@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  await click('Yes, email me');
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('build', undefined);
  expect(container.textContent).toContain('account@example.com');
  expect(container.querySelector('input')).toBeNull();
});

it('restores the saved server recipient without subscribing again', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true, email: 'saved@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  expect(container.textContent).toContain('saved@example.com');
  expect(button('Yes, email me')).toBeUndefined();
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
});

it('validates guest emails, preserves errors, and retries with the saved server recipient', async () => {
  vi.mocked(GenerationEmailApi.subscribe).mockRejectedValueOnce(new Error('Please try again.'))
    .mockResolvedValueOnce({ subscribed: true, email: 'original@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  await click('Yes, email me');
  enterEmail('invalid');
  await click('Notify me');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  enterEmail('new@example.com');
  await click('Notify me');
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Please try again.');
  await click('Notify me');
  expect(container.textContent).toContain('original@example.com');
  expect(container.textContent).not.toContain('new@example.com');
});

it('consumes Enter in the inline email input without submitting its surrounding generation form', async () => {
  const submit = vi.fn(event => event.preventDefault());
  await act(async () => root.render(<form onSubmit={submit}><GetNotifiedButton generationId="build" promptOnStart /></form>));
  await click('Yes, email me'); enterEmail();
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  await act(async () => container.querySelector('input')!.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(true);
  expect(submit).not.toHaveBeenCalled();
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledOnce();
  expect(container.querySelectorAll('form')).toHaveLength(1);
});

it('resets state on account or generation changes and ignores late status responses', async () => {
  let resolveStatus!: (value: { subscribed: boolean; email: string | null }) => void;
  vi.mocked(GenerationEmailApi.status).mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve; }));
  auth.session = { user: { id: 'owner' } };
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  await click('Yes, email me');
  await act(async () => resolveStatus({ subscribed: false, email: null }));
  expect(container.textContent).toContain('guest@example.com');
  await act(async () => root.render(<GetNotifiedButton generationId="edit" />));
  expect(container.textContent).toBe('Get notified');
  auth.session = { user: { id: 'another-owner' } };
  await act(async () => root.render(<GetNotifiedButton generationId="edit" />));
  expect(GenerationEmailApi.status).toHaveBeenCalledTimes(3);
});

it('keeps the prompt retryable if the server did not save a subscription', async () => {
  auth.session = { user: { id: 'owner' } };
  vi.mocked(GenerationEmailApi.subscribe).mockResolvedValue({ subscribed: false, email: null });
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart />));
  await click('Yes, email me');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('couldn’t save');
  expect(button('Yes, email me')).toBeDefined();
});

it('handles legacy servers that omit the recipient', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true, email: null });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  expect(container.textContent).toContain('I’ll email you when your build is ready.');
  expect(container.textContent).not.toContain('email to when');
});

it('uses authenticated transport and sends no client recipient for signed-in requests', async () => {
  vi.mocked(GenerationEmailApi.status).mockRestore();
  vi.mocked(GenerationEmailApi.subscribe).mockRestore();
  vi.mocked(authenticatedApiFetch).mockResolvedValue({ ok: true, json: async () => ({ subscribed: true }) } as Response);
  await expect(GenerationEmailApi.subscribe('build')).resolves.toEqual({ subscribed: true, email: null });
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.stringContaining('/generation/build/notification-email'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  await GenerationEmailApi.subscribe('build', 'guest@example.com');
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ body: '{"email":"guest@example.com"}' }));
  const controller = new AbortController();
  await GenerationEmailApi.status('build', controller.signal);
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.any(String), { signal: controller.signal });
  vi.mocked(authenticatedApiFetch).mockResolvedValue({ ok: false, json: async () => ({ detail: 'This build has stopped.' }) } as Response);
  await expect(GenerationEmailApi.subscribe('build')).rejects.toThrow('This build has stopped.');
});
