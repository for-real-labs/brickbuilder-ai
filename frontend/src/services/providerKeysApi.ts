import { authenticatedApiFetch } from './apiFetch';
export type AiProvider = 'openai' | 'anthropic';
export interface AiBillingSettings {
  billing_source: 'personal' | 'brickbuilder';
  skip_confirmation: boolean;
  providers: AiProvider[];
}
const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002'
  : mode === 'railway_staging' ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
  : import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
async function request(path = '', method = 'GET', body?: object): Promise<AiBillingSettings> {
  const response = await authenticatedApiFetch(`${base}/provider-keys${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : 'Unable to update AI billing settings.');
  }
  return response.json();
}
export const providerKeysApi = {
  status: () => request(),
  save: (provider: AiProvider, api_key: string) => request(`/${provider}`, 'PUT', { api_key }),
  remove: (provider: AiProvider) => request(`/${provider}`, 'DELETE'),
  preferences: (settings: Pick<AiBillingSettings, 'billing_source' | 'skip_confirmation'>) => request('/preferences', 'PUT', settings),
};
export interface PersonalBillingConfirmation { resolve: (answer: boolean) => void }
/** Explicitly choose the source for this job so a later preference change cannot change its payer. */
export async function prepareAiBilling(body: string, signal?: AbortSignal): Promise<string> {
  const payload = JSON.parse(body);
  if (payload.auth_mode === 'native') return body;
  const settings = await providerKeysApi.status();
  signal?.throwIfAborted();
  if (settings.billing_source === 'personal') {
    const provider = String(payload.model || '').startsWith('claude-') ? 'anthropic' : 'openai';
    if (!settings.providers.includes(provider)) throw new Error(`Add your ${provider === 'openai' ? 'OpenAI' : 'Claude'} API key in AI billing settings, or choose BrickBuilder credits.`);
    if (!settings.skip_confirmation) {
      const accepted = await new Promise<boolean>(resolve => {
        const abort = () => finish(false);
        const finish = (value: boolean) => { signal?.removeEventListener('abort', abort); resolve(value); };
        signal?.addEventListener('abort', abort, { once: true });
        window.dispatchEvent(new CustomEvent<PersonalBillingConfirmation>('brickbuilder:confirm-personal-billing', { detail: { resolve: finish } }));
      });
      if (!accepted) throw new Error('Generation cancelled. Your AI account was not charged.');
    }
  }
  signal?.throwIfAborted();
  return JSON.stringify({ ...payload, billing_source: settings.billing_source });
}
