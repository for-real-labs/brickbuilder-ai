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

it('announces automatic completion mail without asking or making a browser subscription', async () => {
  const shown = vi.fn();
  await act(async () => root.render(<GetNotifiedButton generationId="build" promptOnStart onPromptShown={shown} />));
  expect(container.textContent).toContain("You will receive an email when it's ready. You can safely leave this window");
  expect(container.querySelector('button')).toBeNull();
  expect(container.querySelector('input')).toBeNull();
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  expect(shown).toHaveBeenCalledOnce();
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
