import { apiFetch, authenticatedApiFetch } from './apiFetch';
import { DEFAULT_LLM_MODEL, getLlmModelOption, type LlmToBricksResponse } from './llmToBricksApi';

export type NovaAuthMode = 'api_key' | 'native';

export interface NovaBuilderOptions {
  model: string;
  authMode: NovaAuthMode;
}

export const DEFAULT_NOVA_OPTIONS: NovaBuilderOptions = {
  model: DEFAULT_LLM_MODEL,
  authMode: 'api_key',
};

export interface NovaToBricksRequest extends NovaBuilderOptions {
  sourceGenerationId?: string;
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

export class NovaInstructionReviewError extends Error {
  constructor() {
    super('These instructions failed connection review. Use Edit with AI to repair disconnected parts and the build order.');
    this.name = 'NovaInstructionReviewError';
  }
}

export class NovaToBricksApiService {
  static async instructions(generationId: string): Promise<string> {
    const response = await authenticatedApiFetch(`${API_BASE_URL}/generation/${encodeURIComponent(generationId)}/nova-instructions.ldr`);
    if (response.status === 409) throw new NovaInstructionReviewError();
    if (!response.ok) throw new Error('Unable to load Nova construction steps. Please try again.');
    return response.text();
  }

  static async downloadSource(generationId: string): Promise<Blob> {
    const response = await authenticatedApiFetch(`${API_BASE_URL}/generation/${encodeURIComponent(generationId)}/nova-source`);
    if (!response.ok) {
      throw new Error(response.status === 403 ? 'Only the owner can download this agent source.'
        : response.status === 404 ? 'The agent source archive is unavailable for this model.'
        : 'Unable to download the agent source. Please try again.');
    }
    return response.blob();
  }

  static async edit(generationId: string, prompt: string, authToken?: string): Promise<LlmToBricksResponse> {
    return this.generate({ ...DEFAULT_NOVA_OPTIONS, sourceGenerationId: generationId, prompt }, authToken);
  }

  static async generate(request: NovaToBricksRequest, authToken?: string): Promise<LlmToBricksResponse> {
    if (!request.prompt?.trim() && !request.imageBase64) throw new Error('A prompt or image is required');
    if (!getLlmModelOption(request.model)) throw new Error('Choose a supported agent model');
    if (!['api_key', 'native'].includes(request.authMode)) throw new Error('Choose a supported provider connection');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await (authToken ? apiFetch : authenticatedApiFetch)(`${API_BASE_URL}/novaToBricks`, {
      method: 'POST', headers,
      body: JSON.stringify({
        source_generation_id: request.sourceGenerationId,
        prompt: request.prompt?.trim() || undefined,
        image_base64: request.imageBase64,
        image_media_type: request.imageMediaType || 'image/png',
        detail_level: request.detailLevel ?? 40,
        model: request.model,
        auth_mode: request.authMode,
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
