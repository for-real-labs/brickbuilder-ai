import { authenticatedApiFetch } from './apiFetch';
// API Configuration
const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

// Determine API URL based on mode
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

// Generation status types
export type GenerationStatus = 'queued' | 'started' | 'processing' | 'ldr_processing' | 'completed' | 'failed';

// Response type for polling endpoint
export interface GetGenerationResponse {
  generation_id: string;
  status: GenerationStatus;
  prompt: string | null;
  external_image_url: string | null;
  processed_image_url: string | null;
  preview_image_url?: string | null;
  reference_images?: Partial<Record<'front' | 'back' | 'side' | 'top', string>>;
  detail_level: number | null;
  ldr_content: string | null;
  mpd_url: string | null;
  xyzrgb_url: string | null;
  problematic_xyzrgb_url: string | null;
  error_message: string | null;
  is_community?: boolean | null;
}

// Helper type for completed generations
export interface CompletedGeneration {
  generation_id: string;
  prompt: string;
  ldr_content: string;
  mpd_url: string | null;
  xyzrgb_url: string | null;
  problematic_xyzrgb_url: string | null;
}

export class GetGenerationApiService {
  /**
   * Poll the generation status endpoint.
   * Returns the current status of the generation.
   */
  static async getGeneration(generationId: string, signal?: AbortSignal): Promise<GetGenerationResponse> {
    const url = `${API_BASE_URL}/generation/${generationId}`;

    try {
      const response = await authenticatedApiFetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
      }

      const data: GetGenerationResponse = await response.json();
      
      // Validate response structure
      if (!data.generation_id || !data.status) {
        throw new Error('Invalid response structure from getGeneration API');
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch generation: ${String(error)}`);
    }
  }

  /**
   * Poll until generation is completed or failed.
   * Returns the completed generation data or throws an error if failed.
   * @param generationId - The generation ID to poll
   * @param onStatusUpdate - Optional callback for status updates (for showing preview images)
   * @param pollInterval - Time between polls in ms (default: 2500ms)
   * @param maxAttempts - Maximum number of poll attempts (default: 120 = 5 minutes at 2.5s intervals)
   */
  static async pollUntilComplete(
    generationId: string,
    onStatusUpdate?: (response: GetGenerationResponse) => void,
    pollInterval: number = 2500,
    maxAttempts: number = 120,
    signal?: AbortSignal
  ): Promise<CompletedGeneration> {
    let attempts = 0;

    while (attempts < maxAttempts) {
      if (signal?.aborted) {
        throw new DOMException('Polling aborted', 'AbortError');
      }
      const response = await this.getGeneration(generationId, signal);
      
      // Call status update callback if provided
      if (onStatusUpdate) {
        onStatusUpdate(response);
      }

      if (response.status === 'completed') {
        if (!response.ldr_content || !response.prompt) {
          throw new Error('Generation completed but missing required content');
        }
        return {
          generation_id: response.generation_id,
          prompt: response.prompt,
          ldr_content: response.ldr_content,
          mpd_url: response.mpd_url,
          xyzrgb_url: response.xyzrgb_url,
          problematic_xyzrgb_url: response.problematic_xyzrgb_url,
        };
      }

      if (response.status === 'failed') {
        throw new Error(response.error_message || 'Generation failed');
      }

      // Still processing, wait and try again
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollInterval);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Polling aborted', 'AbortError'));
        }, { once: true });
      });
      attempts++;
    }

    throw new Error('Generation timed out');
  }
}
