import { apiFetch } from './apiFetch';
/// <reference types="vite/client" />

export interface LdrToMpdResponse {
  mpd_content: string;
  mpd_last_step_content?: string;
  message: string;
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
      ldrToMpd: `${LOCAL_API_URL}/ldrToMpd`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      ldrToMpd: `${RAILWAY_API_URL_STAGING}/ldrToMpd`,
    };
  } else {
    return {
      ldrToMpd: `${RAILWAY_API_URL}/ldrToMpd`,
    };
  }
};

const API_URLS = getApiUrls();

export class LdrToMpdApiService {
  static async convertLdrToMpd(ldrContent: string, modelName?: string, authToken?: string): Promise<LdrToMpdResponse> {
    //console.log(`Sending LDR to MPD conversion request to backend`);
    
    if (!ldrContent) {
      throw new Error('LDR content is required');
    }

    //console.log('Processing LDR to MPD conversion, LDR size:', ldrContent.length);

    // Prepare headers for API request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication headers if present
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      //console.log('Adding Authorization header');
    }

    try {
      // Forward request to API
      const response = await apiFetch(API_URLS.ldrToMpd, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ldr_content: ldrContent,
          model_name: modelName || 'model.ldr'
        }),
      });

      //console.log(`API response status:`, response.status);

      if (!response.ok) {
        const errorText = await response.text();
        //console.error('Server API error:', errorText);
        
        let errorMessage = 'Failed to convert LDR to MPD';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
          if (errorData.details) {
            //console.error('API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from backend API
      const responseData: LdrToMpdResponse = await response.json();
      // console.log('Received LDR to MPD response data:', {
      //   message: responseData.message,
      //   mpd_length: responseData.mpd_content?.length || 0,
      //   mpd_last_step_length: responseData.mpd_last_step_content?.length || 0
      // });

      // Validate the response structure
      if (!responseData.mpd_content) {
        //console.error('Invalid response: missing MPD content');
        throw new Error('Invalid response from server: missing MPD content');
      }

      return responseData;

    } catch (error) {
      //console.error('LDR to MPD API error:', error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Internal server error');
      }
    }
  }
}