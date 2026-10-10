import { apiFetch } from './apiFetch';

export const LDRAW_UPLOAD_ACCEPT = '.io,.ldr,.mpd';
export const MAX_LDRAW_UPLOAD_BYTES = 16 * 1024 * 1024;
const mode = import.meta.env.VITE_API_MODE || 'local';
const baseUrl = mode === 'local' ? import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002'
  : mode === 'railway_staging' ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
  : import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';

export class UploadLdrawApiService {
  static async upload(file: File, authToken?: string, signal?: AbortSignal): Promise<{ generation_id: string }> {
    if (!/\.(io|ldr|mpd)$/i.test(file.name)) throw new Error('Choose a Studio .io, LDraw .ldr, or .mpd file.');
    if (!file.size) throw new Error('The uploaded file is empty.');
    if (file.size > MAX_LDRAW_UPLOAD_BYTES) throw new Error('Choose a model smaller than 16 MB.');
    const body = new FormData(); body.append('file', file);
    const response = await apiFetch(`${baseUrl}/uploadLdraw`, {
      method: 'POST', body, signal, headers: authToken ? { Authorization: `Bearer ${authToken}` } : undefined,
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw new Error(typeof data?.detail === 'string' ? data.detail : 'Unable to import this model. Please try again.');
    }
    const result = await response.json();
    if (!result.generation_id) throw new Error('The import did not return a model ID. Please try again.');
    return result;
  }
}
