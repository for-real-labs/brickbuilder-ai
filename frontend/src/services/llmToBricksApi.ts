import { apiFetch, authenticatedApiFetch } from './apiFetch';
export type LlmProvider = 'anthropic' | 'openai';

export interface LlmModelOption {
  id: string;
  label: string;
  provider: LlmProvider;
}

// Must match SUPPORTED_MODELS in backend/src/requests/llmToBricks.py; the
// backend rejects any other model id.
export const LLM_MODEL_OPTIONS: readonly LlmModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', provider: 'anthropic' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai' },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai' },
];

export const DEFAULT_LLM_MODEL = 'claude-opus-5-5';

export function getLlmModelOption(id: string): LlmModelOption | undefined {
  return LLM_MODEL_OPTIONS.find((option) => option.id === id);
}

export interface LlmToBricksRequest {
  prompt?: string;
  imageBase64?: string;
  imageMediaType?: string;
  detailLevel?: number;
  model?: string;
}

export interface LlmToBricksResponse {
  generation_id: string;
  message: string;
}

export interface LlmGenerationOutput {
  text: string;
  status: string;
  error?: string | null;
}

type LlmToBricksStreamEvent =
  | { type: 'started'; generation_id: string }
  | { type: 'thinking'; delta: string }
  | { type: 'result'; data: LlmToBricksResponse }
  | { type: 'error'; detail: string };

const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

const API_BASE_URL = API_MODE === 'local'
  ? LOCAL_API_URL
  : API_MODE === 'railway_staging'
    ? RAILWAY_API_URL_STAGING
    : RAILWAY_API_URL;

export class LlmToBricksApiService {
  static async watchOutput(
    generationId: string,
    onOutput: (output: LlmGenerationOutput) => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    const response = await authenticatedApiFetch(`${API_BASE_URL}/generation/${encodeURIComponent(generationId)}/output`, { signal });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('Unable to connect to generation output');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let delimiter: RegExpExecArray | null;
        while ((delimiter = /\r?\n\r?\n/.exec(buffer))) {
          const raw = buffer.slice(0, delimiter.index);
          buffer = buffer.slice(delimiter.index + delimiter[0].length);
          const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = JSON.parse(data);
          if (event.type !== 'output' || typeof event.text !== 'string' || typeof event.status !== 'string') continue;
          onOutput(event);
          if (event.status === 'completed' || event.status === 'failed') return true;
        }
        if (done) return false;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private static buildRequestBody(request: LlmToBricksRequest) {
    const prompt = request.prompt?.trim();
    if (!prompt && !request.imageBase64) {
      throw new Error('A prompt or image is required');
    }
    const model = request.model ?? DEFAULT_LLM_MODEL;
    if (!getLlmModelOption(model)) {
      throw new Error(`Unsupported model: ${model}`);
    }

    return {
      prompt: prompt || undefined,
      image_base64: request.imageBase64,
      image_media_type: request.imageMediaType || 'image/png',
      detail_level: request.detailLevel ?? 40,
      model,
    };
  }

  static async generate(
    request: LlmToBricksRequest,
    authToken?: string,
  ): Promise<LlmToBricksResponse> {
    const body = this.buildRequestBody(request);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = 'Bearer ' + authToken;

    const response = await apiFetch(`${API_BASE_URL}/llmToBricks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Failed to generate a brick model with the LLM';
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error || errorData.detail || errorMessage;
      } catch {
        errorMessage = errorText || `${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const responseData: LlmToBricksResponse = await response.json();
    if (!responseData.generation_id) {
      throw new Error('Invalid response from server: missing generation_id');
    }
    return responseData;
  }

  static async generateStream(
    request: LlmToBricksRequest,
    authToken?: string,
    onThinking?: (delta: string) => void,
    onStarted?: (generationId: string) => void,
  ): Promise<LlmToBricksResponse> {
    const body = this.buildRequestBody(request);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = 'Bearer ' + authToken;

    const response = await apiFetch(`${API_BASE_URL}/llmToBricks/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = 'Failed to generate a brick model with the LLM';
      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.error || errorData.detail || errorMessage;
      } catch {
        errorMessage = errorText || `${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }
    if (!response.body) {
      throw new Error('Response body is null — streaming not supported by browser');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: LlmToBricksResponse | undefined;

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      while (buffer.includes('\n\n')) {
        const delimiterIndex = buffer.indexOf('\n\n');
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        if (!rawEvent.startsWith('data: ')) continue;

        const event = JSON.parse(rawEvent.slice(6)) as LlmToBricksStreamEvent;
        if (event.type === 'started') {
          onStarted?.(event.generation_id);
        } else if (event.type === 'thinking') {
          onThinking?.(event.delta);
        } else if (event.type === 'result') {
          result = event.data;
        } else if (event.type === 'error') {
          throw new Error(event.detail);
        }
      }

      if (done) break;
    }

    if (!result?.generation_id) {
      throw new Error('LLM brick-design stream ended without a result');
    }
    return result;
  }
}
