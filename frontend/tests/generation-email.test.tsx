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
beforeEach(() => {
  auth.session = null;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
  vi.spyOn(GenerationEmailApi, 'subscribe').mockResolvedValue({ subscribed: true, email: 'guest@example.com' });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('prompts after a new generation and shares the card subscription and success message', async () => {
  const onPromptShown = vi.fn();
  await act(async () => root.render(<GetNotifiedButton generationId="new-build" promptOnStart onPromptShown={onPromptShown} />));
  const modal = document.querySelector('[role="dialog"]')!;
  expect(modal.textContent).toContain('This may take up to 30 minutes to generate.');
  expect(modal.textContent).toContain('Would you like to be notified?');
  const input = modal.querySelector('input')!;
  expect(input.placeholder).toBe('you@example.com');
  expect(input.value).toBe('');
  expect(input.className).toContain('placeholder:text-slate-400');
  expect(document.activeElement).toBe(input);
  expect(onPromptShown).toHaveBeenCalledTimes(1);
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('generation_email_notification_prompt_shown', {
    generation_id: 'new-build', is_authenticated: false,
  });
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'guest@example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => modal.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('new-build', 'guest@example.com');
  expect(modal.querySelector('p')!.textContent).toBe("We'll send an email to guest@example.com when your set is ready!");
  expect(container.textContent).toContain('We’ll email you');
  act(() => Array.from(modal.querySelectorAll('button')).find(button => button.textContent === 'Done')!.click());
  act(() => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('guest@example.com');
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('guest@example.com');
});

it.each(['Not now', 'Escape', 'backdrop'])('dismisses the prompt with %s without opting in or reopening', async method => {
  await act(async () => root.render(<GetNotifiedButton generationId="new-build" promptOnStart />));
  const modal = document.querySelector('[role="dialog"]')!;
  act(() => {
    if (method === 'Escape') modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else if (method === 'backdrop') (modal.parentElement as HTMLElement).click();
    else Array.from(modal.querySelectorAll('button')).find(button => button.textContent === method)!.click();
  });
  await act(async () => root.render(<GetNotifiedButton generationId="new-build" promptOnStart />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.style.overflow).toBe('');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('generation_email_notification_dismissed', { generation_id: 'new-build', stage: 'prompt' });
  act(() => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('No newsletter');
});

it('shows the account email and preserves signed-in card enrollment rules in the prompt', async () => {
  auth.session = { user: { id: 'owner', email: 'account@example.com' } };
  vi.mocked(GenerationEmailApi.subscribe).mockResolvedValue({ subscribed: true, email: 'account@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="new-build" promptOnStart />));
  const modal = document.querySelector('[role="dialog"]')!;
  expect(modal.querySelector('input')!.value).toBe('account@example.com');
  expect(modal.querySelector('input')!.readOnly).toBe(true);
  await act(async () => modal.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('new-build', undefined);
  expect(modal.querySelector('p')!.textContent).toBe("We'll send an email to account@example.com when your set is ready!");
});

it('shows a restored subscription instead of offering to subscribe again in the prompt', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true, email: 'saved@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="new-build" promptOnStart />));
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('You’re all set');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('saved@example.com');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
});

it('subscribes a signed-in owner with their server-side account email in one click', async () => {
  auth.session = { user: { id: 'owner' } };
  vi.mocked(GenerationEmailApi.subscribe).mockResolvedValue({ subscribed: true, email: 'account@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  await act(async () => container.querySelector('button')!.click());
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('build', undefined);
  const modal = document.querySelector('[role="dialog"]')!;
  expect(modal.textContent).toContain('You’re all set');
  expect(modal.textContent).toContain('account@example.com');
  expect(modal.querySelector('p')!.textContent).toBe("We'll send an email to account@example.com when your set is ready!");
  expect(modal.querySelector('input')).toBeNull();
  expect(container.textContent).toContain('We’ll email you');
  expect(container.textContent).toContain('Emailing account@example.com');
  expect(posthog.capture).toHaveBeenCalledWith('generation_email_notification_subscribed', { generation_id: 'build', is_authenticated: true });
});

it('lets a guest enter an email without a login, shows errors, and retries', async () => {
  vi.mocked(GenerationEmailApi.subscribe).mockRejectedValueOnce(new Error('Please try again.'));
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  act(() => container.querySelector('button')!.click());
  const modal = document.querySelector('[role="dialog"]')!;
  const input = modal.querySelector('input')!;
  expect(document.activeElement).toBe(input);
  expect(modal.textContent).toContain('No newsletter');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'guest@example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const submit = () => modal.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await act(async () => { submit(); });
  expect(modal.querySelector('[role="alert"]')!.textContent).toBe('Please try again.');
  await act(async () => { submit(); });
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('build', 'guest@example.com');
  expect(modal.textContent).toContain('You’re all set');
  expect(modal.textContent).toContain('guest@example.com');
  expect(modal.querySelector('p')!.textContent).toBe("We'll send an email to guest@example.com when your set is ready!");
  expect(container.textContent).toContain('Emailing guest@example.com');
  expect(modal.querySelector('input')).toBeNull();
  expect(document.body.style.overflow).toBe('hidden');
  act(() => Array.from(modal.querySelectorAll('button')).find(button => button.textContent === 'Done')!.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button'));
  expect(document.body.style.overflow).toBe('');
});

it('restores a saved opt-in after leaving and coming back', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true, email: 'saved@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  expect(container.textContent).toContain('We’ll email you');
  expect(container.textContent).toContain('Emailing saved@example.com');
  act(() => container.querySelector('button')!.click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('saved@example.com');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
});

it('uses the saved server recipient if it differs from the entered email', async () => {
  vi.mocked(GenerationEmailApi.subscribe).mockResolvedValue({ subscribed: true, email: 'original@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  act(() => container.querySelector('button')!.click());
  act(() => {
    const input = document.querySelector('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new@example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('original@example.com');
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('new@example.com');
});

it('resets subscription and modal state when the model or account changes', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValueOnce({ subscribed: true, email: 'saved@example.com' });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  act(() => container.querySelector('button')!.click());
  await act(async () => root.render(<GetNotifiedButton generationId="edit" />));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('Get notified');
  expect(document.body.style.overflow).toBe('');
  auth.session = { user: { id: 'another-owner' } };
  await act(async () => root.render(<GetNotifiedButton generationId="edit" />));
  expect(GenerationEmailApi.status).toHaveBeenCalledTimes(3);
});

it('keeps a late status response from overwriting a successful subscription', async () => {
  let status!: (value: { subscribed: boolean; email: null }) => void;
  vi.mocked(GenerationEmailApi.status).mockImplementation(() => new Promise(resolve => { status = resolve; }));
  auth.session = { user: { id: 'owner' } };
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  await act(async () => container.querySelector('button')!.click());
  await act(async () => status({ subscribed: false, email: null }));
  expect(container.textContent).toContain('We’ll email you');
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('guest@example.com');
});

it('traps focus in the success modal and restores it on Escape', async () => {
  auth.session = { user: { id: 'owner' } };
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  await act(async () => container.querySelector('button')!.click());
  const modal = document.querySelector('[role="dialog"]')!;
  const buttons = modal.querySelectorAll('button');
  expect(document.activeElement).toBe(buttons[0]);
  act(() => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[1]);
  act(() => buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(buttons[0]);
  act(() => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button'));
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

it('does not show an empty recipient sentence when a legacy backend omits the email', async () => {
  auth.session = { user: { id: 'owner' } };
  vi.mocked(GenerationEmailApi.subscribe).mockResolvedValue({ subscribed: true, email: null });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  await act(async () => container.querySelector('button')!.click());
  const modal = document.querySelector('[role="dialog"]')!;
  expect(modal.textContent).toContain('Refresh to see the recipient email address.');
  expect(modal.textContent).not.toContain('email to when');
});
