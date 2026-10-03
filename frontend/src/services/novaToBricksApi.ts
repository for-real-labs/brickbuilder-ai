import { apiFetch, authenticatedApiFetch } from './apiFetch';
import { DEFAULT_LLM_MODEL, getLlmModelOption, type LlmToBricksResponse } from './llmToBricksApi';

export type NovaAuthMode = 'api_key' | 'native';

export interface NovaBuilderOptions {
  model: string;
  authMode: NovaAuthMode;
  maxIterations: number;
  maxParts: number;
  useJev: boolean;
}

export const DEFAULT_NOVA_OPTIONS: NovaBuilderOptions = {
  model: DEFAULT_LLM_MODEL,
  authMode: 'api_key',
  maxIterations: 30,
  maxParts: 5000,
  useJev: true,
};

export interface NovaToBricksRequest extends NovaBuilderOptions {
  prompt?: string;
  imageBase64?: string;
  imageMediaType?: string;
  detailLevel?: number;
}

const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const API_BASE_URL = API_MODE === 'local'
  ? import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002'
  : API_MODE === 'railway_staging'
    ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
    : import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';

export class NovaToBricksApiService {
  static async downloadSource(generationId: string): Promise<Blob> {
    const response = await authenticatedApiFetch(`${API_BASE_URL}/generation/${encodeURIComponent(generationId)}/nova-source`);
    if (!response.ok) {
      throw new Error(response.status === 403 ? 'Only the owner can download this agent source.'
        : response.status === 404 ? 'The agent source archive is unavailable for this model.'
        : 'Unable to download the agent source. Please try again.');
    }
    return response.blob();
  }

  static async generate(request: NovaToBricksRequest, authToken?: string): Promise<LlmToBricksResponse> {
    if (!request.prompt?.trim() && !request.imageBase64) throw new Error('A prompt or image is required');
    if (!getLlmModelOption(request.model)) throw new Error('Choose a supported agent model');
    if (!['api_key', 'native'].includes(request.authMode)) throw new Error('Choose a supported provider connection');
    if (!Number.isInteger(request.maxIterations) || request.maxIterations < 4 || request.maxIterations > 80) {
      throw new Error('Agent steps must be between 4 and 80');
    }
    if (!Number.isInteger(request.maxParts) || request.maxParts < 50 || request.maxParts > 10_000) {
      throw new Error('Part limit must be between 50 and 10,000');
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${API_BASE_URL}/novaToBricks`, {
      method: 'POST', headers,
      body: JSON.stringify({
        prompt: request.prompt?.trim() || undefined,
        image_base64: request.imageBase64,
        image_media_type: request.imageMediaType || 'image/png',
        detail_level: request.detailLevel ?? 40,
        model: request.model,
        auth_mode: request.authMode,
        max_iterations: request.maxIterations,
        max_parts: request.maxParts,
        use_jev: request.useJev,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : 'Unable to start the full set agent');
    }
    const data: LlmToBricksResponse = await response.json();
    if (!data.generation_id) throw new Error('The server did not return a generation ID');
    return data;
  }
}
