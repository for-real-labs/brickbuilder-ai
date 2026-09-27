import { apiFetch } from './apiFetch';
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
  user_id: string;
  prompt: string;
  created_at: string;
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
  processed_image_url: string;
  user_id?: string;
}

export interface GetGenerationsByImageResponse {
  generations: GenerationIteration[];
  total_count: number;
}

export class GetGenerationsByImageApiService {
  static async getGenerationsByImage(
    authToken: string | undefined,
    processedImageUrl: string
  ): Promise<GetGenerationsByImageResponse> {
    const url = `${API_BASE_URL}/getGenerationsByImage`;

    const requestBody: GetGenerationsByImageRequest = {
      processed_image_url: processedImageUrl,
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
      throw new Error(`Failed to fetch generations by image: ${String(error)}`);
    }
  }
}
