import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountDeleted, DeleteAccount } from '../src/components/DeleteAccount';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), signOut: vi.fn(), navigate: vi.fn(), capture: vi.fn(), reset: vi.fn() }));
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: mocks.fetch }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { signOut: mocks.signOut } } }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('posthog-js', () => ({ default: { capture: mocks.capture, reset: mocks.reset } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => [...container.querySelectorAll('button')].find(b => b.textContent === label)!;
const click = async (label: string) => act(async () => button(label).click());
const confirm = async () => act(async () => {
  const input = container.querySelector('input')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'DELETE');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
beforeEach(async () => {
  vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<DeleteAccount />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it('requires confirmation, explains Apple billing, deletes and signs out', async () => {
  await click('Delete my account');
  expect(container.querySelector('a')!.href).toContain('account/subscriptions');
  expect(button('Permanently delete account').disabled).toBe(true);
  await confirm();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
  await click('Permanently delete account');
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
  expect(mocks.navigate).toHaveBeenCalledWith('/account-deleted', { replace: true });
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ confirmation: 'DELETE' });
});
it('keeps the session and allows retry after server failure', async () => {
  await click('Delete my account'); await confirm();
  mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ detail: 'Please retry deletion.' }), { status: 503 }));
  await click('Permanently delete account');
  expect(container.querySelector('[role="alert"]')!.textContent).toContain('Please retry');
  expect(mocks.signOut).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  expect(button('Permanently delete account').disabled).toBe(false);
});
it('canceling never sends a request', async () => {
  await click('Delete my account'); await click('Keep account'); expect(mocks.fetch).not.toHaveBeenCalled();
});

it('confirmation page keeps Apple cancellation accessible and records navigation', async () => {
  await act(async () => root.render(<AccountDeleted />));
  expect(container.textContent).toContain('permanently deleted');
  const links = [...container.querySelectorAll('a')];
  expect(links[0].href).toBe('https://apps.apple.com/account/subscriptions');
  for (const link of links) {
    link.addEventListener('click', event => event.preventDefault());
    await act(async () => link.click());
  }
  expect(mocks.capture).toHaveBeenCalledWith('account_deletion_apple_subscriptions_clicked');
  expect(mocks.capture).toHaveBeenCalledWith('account_deletion_home_clicked');
});
