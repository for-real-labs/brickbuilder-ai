import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NovaProviderLoginModal } from '../src/components/NovaProviderLoginModal';
import { LocalProvidersApiService, type LocalProviderStatus } from '../src/services/localProvidersApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const row = (id: 'openai' | 'anthropic', extra: Partial<LocalProviderStatus> = {}): LocalProviderStatus => ({
  id, label: id, api_key_configured: false, cli_available: true, cli_connected: false,
  login: { status: 'disconnected' }, capabilities: ['browser_login'], ...extra,
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const close = vi.fn(), connected = vi.fn();
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === label)!;
beforeEach(() => {
  close.mockReset(); connected.mockReset();
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => row(id as 'openai' | 'anthropic'));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('uses Nova device login, protects the code and detects the completed account connection', async () => {
  vi.useFakeTimers();
  const login = vi.spyOn(LocalProvidersApiService, 'login').mockResolvedValue(row('openai', {
    login: {status:'pending',url:'https://auth.openai.com/device',code:'private-device-code'},
  }));
  await act(async () => root.render(<NovaProviderLoginModal provider="openai" onClose={close} onConnected={connected} />));
  expect(container.querySelector('[role="dialog"]')?.className).toContain('ph-no-capture');
  await act(async () => button('Sign in to ChatGPT').click());
  expect(login).toHaveBeenCalledWith('openai');
  expect(container.querySelector('a')?.href).toBe('https://auth.openai.com/device');
  expect(JSON.stringify(localStorage)).not.toContain('private-device-code');
  vi.mocked(LocalProvidersApiService.getProviderStatus).mockResolvedValue(row('openai', {cli_connected:true,login:{status:'connected'}}));
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(connected).toHaveBeenCalledWith('native');
});

it('lets users explicitly select an existing API key without requiring provider login', async () => {
  const login = vi.spyOn(LocalProvidersApiService, 'login');
  vi.mocked(LocalProvidersApiService.getProviderStatus).mockResolvedValue(row('anthropic', {api_key_configured:true}));
  await act(async () => root.render(<NovaProviderLoginModal provider="anthropic" onClose={close} onConnected={connected} />));
  await act(async () => button('Use project API key').click());
  expect(connected).toHaveBeenCalledWith('api_key');
  expect(login).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));
  expect(close).toHaveBeenCalledOnce();
});

it('ignores an old login response when the provider modal has changed', async () => {
  let finish!: (value:LocalProviderStatus) => void;
  vi.spyOn(LocalProvidersApiService, 'login').mockReturnValue(new Promise(resolve=>{finish=resolve;}));
  await act(async () => root.render(<NovaProviderLoginModal provider="openai" onClose={close} onConnected={connected} />));
  act(() => button('Sign in to ChatGPT').click());
  await act(async () => root.render(<NovaProviderLoginModal provider="anthropic" onClose={close} onConnected={connected} />));
  await act(async () => finish(row('openai',{cli_connected:true,login:{status:'connected'}})));
  expect(container.textContent).toContain('Connect Claude');
  expect(connected).not.toHaveBeenCalled();
});
