import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { LocalProviderSettings } from '../src/components/LocalProviderSettings';
import { LocalProvidersApiService, type LocalProviderStatus } from '../src/services/localProvidersApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const provider = (id: LocalProviderStatus['id'], overrides: Partial<LocalProviderStatus> = {}): LocalProviderStatus => ({
  id, label: id, api_key_configured: false, cli_available: true, cli_connected: false,
  login: { status: 'disconnected' }, capabilities: ['api_key', 'browser_login'], ...overrides,
});
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === label)!;

beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.spyOn(LocalProvidersApiService, 'getStatus').mockResolvedValue({ enabled: true, providers: [provider('openai'), provider('anthropic'), provider('fal')] });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('local provider settings', () => {
  it('loads provider status only after opening settings and attaches a private key without analytics or browser storage leaks', async () => {
    const save = vi.spyOn(LocalProvidersApiService, 'saveApiKey').mockResolvedValue(provider('openai', { api_key_configured: true }));
    await act(async () => root.render(<LocalProviderSettings />));
    expect(LocalProvidersApiService.getStatus).not.toHaveBeenCalled();
    await act(async () => button('Local provider connections').click());
    expect(container.textContent).toContain('Sign in to ChatGPT');
    expect(container.textContent).toContain('Sign in to Claude');
    expect(container.textContent).toContain('Sign in to fal.ai');
    act(() => button('Use API key').click());
    const input = container.querySelector<HTMLInputElement>('#local-key-openai')!;
    expect(input.type).toBe('password');
    expect(input.classList.contains('ph-no-capture')).toBe(true);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'private-project-secret');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(save).toHaveBeenCalledWith('openai', 'private-project-secret');
    expect(input.value).toBe('');
    expect(container.textContent).toContain('Project API key attached');
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('private-project-secret');
    expect(JSON.stringify(localStorage)).not.toContain('private-project-secret');
    expect(JSON.stringify(sessionStorage)).not.toContain('private-project-secret');
  });

  it('shows pending browser login and polls until the account is connected', async () => {
    vi.useFakeTimers();
    const login = vi.spyOn(LocalProvidersApiService, 'login').mockResolvedValue(provider('openai', { login: { status: 'pending', url: 'https://auth.openai.com/device', code: 'ABC123' } }));
    await act(async () => root.render(<LocalProviderSettings />));
    await act(async () => button('Local provider connections').click());
    await act(async () => button('Sign in to ChatGPT').click());
    expect(login).toHaveBeenCalledWith('openai');
    const link = container.querySelector('a')!;
    expect(link.href).toBe('https://auth.openai.com/device');
    expect(link.rel).toContain('noopener');
    expect(link.classList.contains('ph-no-capture')).toBe(true);
    expect(container.textContent).toContain('ABC123');
    vi.mocked(LocalProvidersApiService.getStatus).mockResolvedValue({ enabled: true, providers: [provider('openai', { cli_connected: true, login: { status: 'connected' } })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(container.textContent).toContain('Account connected');
    expect(container.querySelector('a')).toBeNull();
  });

  it('blocks unsafe login links and explains unavailable local tools', async () => {
    vi.mocked(LocalProvidersApiService.getStatus).mockResolvedValue({ enabled: true, providers: [provider('anthropic', {
      cli_available: false, install_hint: 'Install the Claude agent tool', login: { status: 'pending', url: 'https://attacker.example' },
    })] });
    await act(async () => root.render(<LocalProviderSettings />));
    await act(async () => button('Local provider connections').click());
    expect(container.querySelector('a')).toBeNull();
    expect((button('Waiting for sign in…') as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toContain('Install the Claude agent tool');
  });

  it('removes a project key and cancels a pending local login', async () => {
    vi.mocked(LocalProvidersApiService.getStatus).mockResolvedValue({ enabled: true, providers: [provider('fal', { api_key_configured: true, login: { status: 'pending' } })] });
    const cancel = vi.spyOn(LocalProvidersApiService, 'cancelLogin').mockResolvedValue(provider('fal', { api_key_configured: true }));
    const remove = vi.spyOn(LocalProvidersApiService, 'removeApiKey').mockResolvedValue(provider('fal'));
    await act(async () => root.render(<LocalProviderSettings />));
    await act(async () => button('Local provider connections').click());
    await act(async () => button('Cancel sign in').click());
    expect(cancel).toHaveBeenCalledWith('fal');
    act(() => button('Use API key').click());
    await act(async () => button('Remove project API key').click());
    expect(remove).toHaveBeenCalledWith('fal');
    expect(container.textContent).toContain('Not connected');
  });

  it('accepts the Claude browser code as a private fallback and clears it after submission', async () => {
    vi.mocked(LocalProvidersApiService.getStatus).mockResolvedValue({ enabled: true, providers: [provider('anthropic', { login: { status: 'pending' } })] });
    const submit = vi.spyOn(LocalProvidersApiService, 'submitClaudeCode').mockResolvedValue(provider('anthropic', { cli_connected: true, login: { status: 'connected' } }));
    await act(async () => root.render(<LocalProviderSettings />));
    await act(async () => button('Local provider connections').click());
    act(() => button('Browser gave you a sign in code?').click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Claude sign in code"]')!;
    expect(input.type).toBe('password');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'private-auth-code');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(submit).toHaveBeenCalledWith('private-auth-code');
    expect(container.textContent).toContain('Account connected');
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('private-auth-code');
  });
});
