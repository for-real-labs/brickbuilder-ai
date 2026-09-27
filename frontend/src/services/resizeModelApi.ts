import { apiFetch } from './apiFetch';
/// <reference types="vite/client" />

export interface ResizeModelResponse {
  ldr_content?: string;
  mpd_content?: string;
  xyzrgb_content?: string;
  message: string;
  generation_id: string;
}

// API Configuration
const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

// Determine API URLs based on mode
const getApiUrls = () => {
  if (API_MODE === 'local') {
    return {
      resizeModel: `${LOCAL_API_URL}/resizeModel`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      resizeModel: `${RAILWAY_API_URL_STAGING}/resizeModel`,
    };
  } else {
    return {
      resizeModel: `${RAILWAY_API_URL}/resizeModel`,
    };
  }
};

const API_URLS = getApiUrls();

export class ResizeModelApiService {
  static async resizeModel(generationId: string, detailLevel: number, authToken?: string): Promise<ResizeModelResponse> {
    console.log(`Sending resize model request to backend`);
    
    if (!generationId) {
      throw new Error('Generation ID is required');
    }

    console.log('Processing resize request:', { generationId, detailLevel });

    // Prepare headers for API request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication headers if present
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      console.log('Adding Authorization header for resize request');
    }

    try {
      // Send resize request to API
      const response = await apiFetch(API_URLS.resizeModel, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          generation_id: generationId,
          detail_level: detailLevel,
          use_red_bricks: true
        }),
      });

      console.log(`Resize API response status:`, response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Resize API error:', errorText);
        
        let errorMessage = 'Failed to resize model';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
          if (errorData.details) {
            console.error('Resize API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from API (returns both LDR and MPD content)
      const responseData: ResizeModelResponse = await response.json();
      
      console.log('Resize API response received:', {
        message: responseData.message,
        ldr_length: responseData.ldr_content?.length || 0,
        mpd_length: responseData.mpd_content?.length || 0,
        generation_id: responseData.generation_id
      });
      
      // Validate the response structure
      if (!responseData.generation_id) {
        throw new Error('Invalid resize response: missing generation ID');
      }

      return responseData;

    } catch (error) {
      console.error('Resize API request failed:', error);
      throw error;
    }
  }
}