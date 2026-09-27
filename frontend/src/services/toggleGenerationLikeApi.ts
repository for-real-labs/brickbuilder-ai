import { readApiError } from "./apiError";

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

export interface ToggleGenerationLikeResponse {
  generation_id: string;
  like_count: number;
  has_liked: boolean;
}

export class ToggleGenerationLikeApiService {
  static async toggleGenerationLike(
    generationId: string,
    accessToken?: string,
  ): Promise<ToggleGenerationLikeResponse> {
    const url = `${API_BASE_URL}/toggleGenerationLike`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (accessToken) {
      headers['Authorization'] = 'Bearer ' + accessToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ generation_id: generationId }),
    });

    if (!response.ok) {
      const errorMessage = await readApiError(response);
      throw new Error(`API error: ${response.status} - ${errorMessage}`);
    }

    return response.json();
  }
}
