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
export interface PromptEditModelRequest {
  generation_id: string;
  edit_prompt: string;
  model_option?: string;
}

// Response from async POST endpoint (initiates edit generation)
export interface PromptEditModelResponse {
  generation_id: string;
  message: string;
}

export class PromptEditModelApiService {
  /**
   * Initiates an async prompt edit operation.
   * Returns immediately with a generation_id that can be polled for status.
   */
  static async promptEditModel(
    generationId: string,
    editPrompt: string,
    authToken?: string,
    modelOption: string = 'b'
  ): Promise<PromptEditModelResponse> {
    const url = `${API_BASE_URL}/promptEditModel`;
    
    const requestBody: PromptEditModelRequest = {
      generation_id: generationId,
      edit_prompt: editPrompt,
      model_option: modelOption
    };

    try {
      const headers: HeadersInit = {
        'Content-Type': 'application/json',
      };

      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const response = await apiFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
      }

      const data: PromptEditModelResponse = await response.json();
      
      // Validate response structure
      if (!data.generation_id) {
        throw new Error('Invalid response structure from promptEditModel API');
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to edit model with prompt: ${String(error)}`);
    }
  }
}
