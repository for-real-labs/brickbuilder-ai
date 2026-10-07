import { apiFetch } from './apiFetch';
/// <reference types="vite/client" />

export interface PartListItem {
  design_id: string;
  color_id: number | null;
  ldraw_color_id: number;
  quantity: number;
}

export interface EstimatePriceResponse {
  cart_id: string | null;
  total_price: string;
  currency: string;
  parts_count: number;
  mapped_parts: number;
  unmapped_parts: number;
  message: string;
  parts_list: PartListItem[];
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
      estimatePrice: `${LOCAL_API_URL}/estimatePrice`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      estimatePrice: `${RAILWAY_API_URL_STAGING}/estimatePrice`,
    };
  } else {
    return {
      estimatePrice: `${RAILWAY_API_URL}/estimatePrice`,
    };
  }
};

const API_URLS = getApiUrls();

export class EstimatePriceApiService {
  static async estimatePrice(
    ldrContent: string, 
    condition: string = 'usedg', 
    country: string = 'US', 
    userEmail: string = 'anonymous@example.com',
    authToken?: string
  ): Promise<EstimatePriceResponse> {
    
    if (!ldrContent) {
      throw new Error('LDR content is required');
    }

    // Prepare headers for API request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication headers if present
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      // Send price estimation request to API
      const response = await apiFetch(API_URLS.estimatePrice, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ldr_content: ldrContent,
          condition,
          country,
          user_email: userEmail
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Price estimation API error:', errorText);
        
        let errorMessage = 'Failed to estimate price';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
          if (errorData.details) {
            console.error('Price estimation API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from API
      const responseData: EstimatePriceResponse = await response.json();

      // Log unmapped parts for debugging
      if (responseData.unmapped_parts > 0) {
        console.log('Warning! Unmapped parts returned:', responseData.unmapped_parts);
      }

      // Store cart_id in localStorage for future checkout
      if (responseData.cart_id) {
        localStorage.setItem('current_cart_id', responseData.cart_id);
      }

      // Store parts_list in localStorage for future checkout
      localStorage.setItem('current_parts_list', JSON.stringify(responseData.parts_list));

      return responseData;

    } catch (error) {
      console.error('Price estimation request failed');
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Unknown error occurred during price estimation');
      }
    }
  }
}
