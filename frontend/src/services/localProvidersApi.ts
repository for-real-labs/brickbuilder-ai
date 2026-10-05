import { apiFetch } from './apiFetch';

export type LocalProviderId = 'openai' | 'anthropic' | 'fal';
export type LocalLoginStatus = 'disconnected' | 'connected' | 'starting' | 'pending' | 'error' | 'expired';
export interface LocalProviderStatus {
  id: LocalProviderId;
  label: string;
  api_key_configured: boolean;
  cli_available: boolean;
  cli_connected: boolean;
  login: { status: LocalLoginStatus; url?: string; code?: string; message?: string };
  capabilities: string[];
  install_hint?: string;
}
export interface LocalProvidersResponse { enabled: boolean; providers: LocalProviderStatus[] }

const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isLocalDevelopment(): boolean {
  try {
    return (import.meta.env.VITE_API_MODE || 'local') === 'local'
      && LOOPBACK_HOSTS.has(new URL(LOCAL_API_URL).hostname)
      && typeof window !== 'undefined' && LOOPBACK_HOSTS.has(window.location.hostname);
  } catch { return false; }
}

// Only open the provider's authentication pages, never arbitrary URLs returned
// by a subprocess or a server response.
export function safeProviderLoginUrl(provider: LocalProviderId, value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hosts: Record<LocalProviderId, string[]> = {
      openai: ['auth.openai.com', 'chatgpt.com', 'platform.openai.com'],
      anthropic: ['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com'],
      fal: ['fal.ai', 'www.fal.ai', 'auth.fal.ai'],
    };
    return url.protocol === 'https:' && !url.username && !url.password && hosts[provider].includes(url.hostname)
      ? url.href : undefined;
  } catch { return undefined; }
}

export class LocalProvidersApiService {
  private static async request<T>(path = '', init: RequestInit = {}): Promise<T> {
    if (!isLocalDevelopment()) throw new Error('Provider connections are available on localhost');
    const response = await apiFetch(`${LOCAL_API_URL}/local/providers${path}`, { ...init, cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 404) throw new Error('Local provider connections are disabled. Restart the local development server with local connections enabled.');
      // Credentials are deliberately excluded from error messages and analytics.
      throw new Error('Unable to update the local provider connection. Check the local server and try again.');
    }
    return response.json();
  }

  static getStatus(signal?: AbortSignal): Promise<LocalProvidersResponse> {
    return this.request('', { signal });
  }

  static login(provider: LocalProviderId): Promise<LocalProviderStatus> {
    return this.request(`/${provider}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  }

  static saveApiKey(provider: LocalProviderId, apiKey: string): Promise<LocalProviderStatus> {
    if (!apiKey.trim()) return Promise.reject(new Error('Enter an API key'));
    return this.request(`/${provider}/credentials`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey.trim() }),
    });
  }

  static removeApiKey(provider: LocalProviderId): Promise<LocalProviderStatus> {
    return this.request(`/${provider}/credentials`, { method: 'DELETE' });
  }

  static cancelLogin(provider: LocalProviderId): Promise<LocalProviderStatus> {
    return this.request(`/${provider}/login`, { method: 'DELETE' });
  }

  static submitClaudeCode(code: string): Promise<LocalProviderStatus> {
    if (!code.trim()) return Promise.reject(new Error('Enter the Claude sign in code'));
    return this.request('/anthropic/login/code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }),
    });
  }
}
