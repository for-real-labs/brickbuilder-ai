import { authenticatedApiFetch } from './apiFetch';

const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? (import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002')
  : mode === 'railway_staging' ? (import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app')
    : (import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app');

export interface ModelNotification {
  id: string;
  prompt: string;
  status: string;
  seen: boolean;
  updated_at: string;
  image_url?: string;
  is_edit: boolean;
}
export interface NotificationFeed {
  notifications: ModelNotification[];
  active: ModelNotification[];
  unread_count: number;
}
export class NotificationApiError extends Error {
  constructor(public readonly status: number) { super(`Unable to update notifications (${status})`); }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await authenticatedApiFetch(`${base}${path}`, init);
  if (!response.ok) throw new NotificationApiError(response.status);
  return response.json();
}
export const GenerationNotificationsApi = {
  list: (signal?: AbortSignal) => request<NotificationFeed>('/generation-notifications', { signal }),
  markViewed: (id: string) => request(`/generation/${encodeURIComponent(id)}/viewed`, { method: 'POST' }),
  latestEdit: (id: string, signal?: AbortSignal) => request<{ generation_id: string | null }>(`/generation/${encodeURIComponent(id)}/latest-edit`, { signal }),
};
