import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GetNotifiedButton } from '../src/components/GetNotifiedButton';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { authenticatedApiFetch } from '../src/services/apiFetch';

const auth = vi.hoisted(() => ({ session: null as null | { user: { id: string } } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: vi.fn() }));
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
beforeEach(() => {
  auth.session = null;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false });
  vi.spyOn(GenerationEmailApi, 'subscribe').mockResolvedValue({ subscribed: true });
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('subscribes a signed-in owner with their server-side account email in one click', async () => {
  auth.session = { user: { id: 'owner' } };
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  await act(async () => container.querySelector('button')!.click());
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('build', undefined);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('We’ll email you');
  expect(container.querySelector('button')!.getAttribute('aria-disabled')).toBe('true');
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
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('button'));
  expect(document.body.style.overflow).toBe('');
});

it('restores a saved opt-in after leaving and coming back', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true });
  await act(async () => root.render(<GetNotifiedButton generationId="build" />));
  expect(container.textContent).toContain('We’ll email you');
  expect(container.querySelector('button')!.getAttribute('aria-disabled')).toBe('true');
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
});

it('uses authenticated transport and sends no client recipient for signed-in requests', async () => {
  vi.mocked(GenerationEmailApi.status).mockRestore();
  vi.mocked(GenerationEmailApi.subscribe).mockRestore();
  vi.mocked(authenticatedApiFetch).mockResolvedValue({ ok: true, json: async () => ({ subscribed: true }) } as Response);
  await GenerationEmailApi.subscribe('build');
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
