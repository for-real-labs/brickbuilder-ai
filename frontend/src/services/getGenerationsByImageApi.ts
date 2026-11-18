import { apiFetch } from './apiFetch';
import { readApiError } from './apiError';
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

// Types for the API response
export interface GenerationIteration {
  id: string;
  generation_id: string;
  version: number;
  user_id: string;
  prompt: string;
  name?: string | null;
  preview_image_url?: string | null;
  processed_image_url?: string | null;
  created_at: string;
  generation_duration_seconds?: number | null;
  status: string;
  ldr_url?: string;
  xyzrgb_url?: string;
  image_url?: string;
  thumbnail_url?: string;
  external_image_url?: string;
  detail_level?: number;
  endpoint?: string;
  updated_at?: string;
}

export interface GetGenerationsByImageRequest {
  generation_id: string;
  user_id?: string;
}

export interface GetGenerationsByImageResponse {
  generations: GenerationIteration[];
  total_count: number;
}

export class GetGenerationsByImageApiService {
  static async deleteGeneration(generationId: string, scope: 'version' | 'model', authToken: string | undefined): Promise<string | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${API_BASE_URL}/generation/${encodeURIComponent(generationId)}/delete`, {
      method: 'POST', headers, body: JSON.stringify({ scope }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const { next_generation_id } = await response.json();
    if (next_generation_id !== null && typeof next_generation_id !== 'string') {
      throw new Error('Could not confirm the deletion. Please try again.');
    }
    return next_generation_id;
  }

  static async restoreVersion(generationId: string, requestId: string, authToken: string | undefined): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${API_BASE_URL}/generation/${encodeURIComponent(generationId)}/restore`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ request_id: requestId }),
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const { generation_id } = await response.json();
    if (typeof generation_id !== 'string' || !generation_id) throw new Error('Could not open the restored version. Please try again.');
    return generation_id;
  }

  static async getGenerationsByImage(
    authToken: string | undefined,
    generationId: string
  ): Promise<GetGenerationsByImageResponse> {
    const url = `${API_BASE_URL}/getGenerationsByImage`;

    const requestBody: GetGenerationsByImageRequest = {
      generation_id: generationId,
    };

    // Build headers conditionally - only add Authorization if token exists
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      const response = await apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
      }

      const data: GetGenerationsByImageResponse = await response.json();
      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch model versions: ${String(error)}`);
    }
  }
}
