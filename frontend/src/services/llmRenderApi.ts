import { apiFetch } from './apiFetch';
// API Configuration
const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

const getApiUrl = () => {
  if (API_MODE === 'local') {
    return LOCAL_API_URL;
  } else if (API_MODE === 'railway_staging') {
    return RAILWAY_API_URL_STAGING;
  } else {
    return RAILWAY_API_URL;
  }
};

const API_BASE_URL = getApiUrl();

export interface LlmRenderRequest {
  generation_id: string;
  xyzrgb_url: string;
  reference_image_url?: string;
  reference_image_urls?: string[];
  prompt?: string;
  model?: string;
  max_segments?: number;
  check_segmentation?: boolean;
  max_segmentation_rounds?: number;
}

// Model used for /llmRender calls. Any OpenAI model name is routed to OpenAI
// by the backend; a "claude-..." name (like this one) is routed to Anthropic
// instead. Override via VITE_LLM_RENDER_MODEL to swap models without a code
// change.
const LLM_RENDER_MODEL = import.meta.env.VITE_LLM_RENDER_MODEL || 'claude-fable-5';


export interface LlmRenderAppliedRule {
  segment_id: number;
  name: string;
  reason: string | null;
  color: [number, number, number];
  changed_voxels: number;
}

export interface LlmRenderSegmentationAdjustment {
  action: 'merge' | 'split';
  segment_ids?: number[];
  into?: number;
  segment_id?: number;
  pieces?: number;
  new_segment_ids?: number[];
  reason?: string | null;
  round?: number;
}

export type LlmRenderSegmentationStopReason =
  | 'good'
  | 'no_change'
  | 'cycle'
  | 'max_rounds'
  | 'error';

export interface LlmRenderResponse {
  xyzrgb_content: string;
  voxel_count: number;
  segment_count: number;
  model: string;
  applied_rules: LlmRenderAppliedRule[];
  segmentation_adjustments?: LlmRenderSegmentationAdjustment[];
  segmentation_rounds?: number;
  segmentation_stop_reason?: LlmRenderSegmentationStopReason | null;
  preview_image?: string | null;
  reference_images: Record<'front' | 'back' | 'side' | 'top', string>;
  message: string;
}

export class LlmRenderApiService {
  static async llmRender(
    generationId: string,
    xyzrgbUrl: string,
    referenceImageUrls: string | string[],
    prompt?: string,
    accessToken?: string,
    maxSegmentationRounds?: number,
  ): Promise<LlmRenderResponse> {
    const url = `${API_BASE_URL}/llmRender`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }

    const requestBody: LlmRenderRequest = {
      generation_id: generationId,
      xyzrgb_url: xyzrgbUrl,
      reference_image_urls: Array.isArray(referenceImageUrls)
        ? referenceImageUrls
        : [referenceImageUrls],
      prompt,
      model: LLM_RENDER_MODEL,
      ...(typeof maxSegmentationRounds === 'number'
        ? { max_segmentation_rounds: maxSegmentationRounds }
        : {}),
    };

    const response = await apiFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
    }

    const data: LlmRenderResponse = await response.json();
    if (!data.xyzrgb_content) {
      throw new Error('Invalid response structure from llmRender API');
    }

    return data;
  }

  static async llmRenderStream(
    generationId: string,
    xyzrgbUrl: string,
    referenceImageUrls: string | string[],
    prompt?: string,
    accessToken?: string,
    onThinking?: (delta: string) => void,
    maxSegmentationRounds?: number,
  ): Promise<LlmRenderResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) {
      headers.Authorization = 'Bearer ' + accessToken;
    }

    const response = await apiFetch(`${API_BASE_URL}/llmRender/stream`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        generation_id: generationId,
        xyzrgb_url: xyzrgbUrl,
        reference_image_urls: Array.isArray(referenceImageUrls)
          ? referenceImageUrls
          : [referenceImageUrls],
        prompt,
        model: LLM_RENDER_MODEL,
        ...(typeof maxSegmentationRounds === 'number'
          ? { max_segmentation_rounds: maxSegmentationRounds }
          : {}),
      } satisfies LlmRenderRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
    }
    if (!response.body) {
      throw new Error('Response body is null — streaming not supported by browser');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: LlmRenderResponse | undefined;

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      while (buffer.includes('\n\n')) {
        const delimiterIndex = buffer.indexOf('\n\n');
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        if (!rawEvent.startsWith('data: ')) continue;

        const event = JSON.parse(rawEvent.slice(6)) as
          | { type: 'thinking'; delta: string }
          | { type: 'result'; data: LlmRenderResponse }
          | { type: 'error'; detail: string };
        if (event.type === 'thinking') {
          onThinking?.(event.delta);
        } else if (event.type === 'result') {
          result = event.data;
        } else if (event.type === 'error') {
          throw new Error(event.detail);
        }
      }

      if (done) break;
    }

    if (!result?.xyzrgb_content) {
      throw new Error('LLM render stream ended without a result');
    }
    return result;
  }
}
