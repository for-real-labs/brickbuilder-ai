import { apiFetch } from './apiFetch';
import type { OrderQuote } from '../utils/orderCheckout';
/// <reference types="vite/client" />

export interface CreateCheckoutSessionRequest {
  name?: string;
  priceCents?: number;
  quantity?: number;
  generationId?: string;
  brickowlCartId?: string;
  uiMode?: 'hosted' | 'custom' | 'embedded' | 'elements';
  customerEmail?: string;
}

export interface CreateCheckoutSessionResponse {
  session_id: string;
  checkout_url?: string | null;
  client_secret?: string | null;
  price_data?: OrderQuote;
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
      createCheckoutSession: `${LOCAL_API_URL}/createCheckoutSession`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      createCheckoutSession: `${RAILWAY_API_URL_STAGING}/createCheckoutSession`,
    };
  } else {
    return {
      createCheckoutSession: `${RAILWAY_API_URL}/createCheckoutSession`,
    };
  }
};

const API_URLS = getApiUrls();

export class CreateCheckoutSessionApiService {
  static async createCheckoutSession(
    request: CreateCheckoutSessionRequest,
    authToken?: string
  ): Promise<CreateCheckoutSessionResponse> {
    
    // Prepare headers for API request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication headers if present
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      // Send checkout session creation request to API
      const response = await apiFetch(API_URLS.createCheckoutSession, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        const errorText = await response.text();
        
        let errorMessage = 'Failed to create checkout session';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from API
      const responseData: CreateCheckoutSessionResponse = await response.json();

      return responseData;

    } catch (error) {
      console.error('Create checkout session request failed');
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Unknown error occurred during checkout session creation');
      }
    }
  }
}
