import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PasskeySettings } from '../src/components/PasskeySettings';

const mocked = vi.hoisted(() => ({ register: vi.fn(), user: { is_anonymous: false } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: mocked.user }) }));
vi.mock('../src/services/deviceAuth', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/deviceAuth')>(),
  deviceAuthOptions: () => ({ passkey: true }),
}));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth: { registerPasskey: mocked.register } } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocked.user.is_anonymous = false;
  mocked.register.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('adds a passkey to the signed-in account and shows success after verification', async () => {
  mocked.register.mockResolvedValue({ data: { id: 'passkey' }, error: null });
  act(() => root.render(<PasskeySettings />));
  await act(async () => container.querySelector('button')!.click());
  expect(mocked.register).toHaveBeenCalledWith({ options: { signal: expect.any(AbortSignal) } });
  expect(container.querySelector('[role="status"]')?.textContent).toBe('Passkey added.');
});

it('keeps guest accounts from registering a passkey', () => {
  mocked.user.is_anonymous = true;
  act(() => root.render(<PasskeySettings />));
  expect(container.querySelector('button')).toBeNull();
  expect(mocked.register).not.toHaveBeenCalled();
});
