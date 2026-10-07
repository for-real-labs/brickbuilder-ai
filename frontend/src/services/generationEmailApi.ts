import { authenticatedApiFetch } from './apiFetch';

const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? (import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002')
  : mode === 'railway_staging' ? (import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app')
    : (import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app');

async function request(id: string, init: RequestInit = {}) {
  const response = await authenticatedApiFetch(`${base}/generation/${encodeURIComponent(id)}/notification-email`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not save your notification. Please try again.');
  }
  return response.json() as Promise<{ subscribed: boolean; email: string | null }>;
}

export const GenerationEmailApi = {
  status: (id: string, signal?: AbortSignal) => request(id, { signal }),
  subscribe: (id: string, email?: string) => request(id, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  }),
};
