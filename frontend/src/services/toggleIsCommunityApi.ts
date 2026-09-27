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

// Request and Response types
export interface ToggleIsCommunityRequest {
  generation_id: string;
}

export interface ToggleIsCommunityResponse {
  generation_id: string;
  is_community?: boolean;
  isCommunity?: boolean;
  success?: boolean;
  message?: string;
}

export class ToggleIsCommunityApiService {
  static async toggleIsCommunity(
    generationId: string,
    accessToken?: string
  ): Promise<ToggleIsCommunityResponse> {
    const url = `${API_BASE_URL}/toggleIsCommunity`;

    const requestBody: ToggleIsCommunityRequest = {
      generation_id: generationId,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    try {
      const response = await apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} - ${errorText}`);
      }

      const data: ToggleIsCommunityResponse = await response.json();
      return data;
    } catch (error) {
      console.error('ToggleIsCommunity API error:', error);
      throw error;
    }
  }
}
