import { apiFetch } from './apiFetch';
/// <reference types="vite/client" />

export interface PartBreakdownItem {
  part_id: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  color_id?: number;
  sku?: string;
}

export interface GetPriceResponse {
  generation_id: string;
  total_price: number;
  total_parts: number;
  total_weight: number;
  unique_part_types: number;
  currency: string;
  parts_breakdown: PartBreakdownItem[];
  message: string;
  price_source?: string;
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
      getPrice: `${LOCAL_API_URL}/getPrice`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      getPrice: `${RAILWAY_API_URL_STAGING}/getPrice`,
    };
  } else {
    return {
      getPrice: `${RAILWAY_API_URL}/getPrice`,
    };
  }
};

const API_URLS = getApiUrls();

export class GetPriceApiService {
  static async getPrice(
    generationId: string,
    authToken?: string
  ): Promise<GetPriceResponse> {
    
    if (!generationId) {
      throw new Error('Generation ID is required');
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
      // Send price request to API
      const response = await apiFetch(API_URLS.getPrice, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          generation_id: generationId
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Get price API error:', errorText);
        
        let errorMessage = 'Failed to get price';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
          if (errorData.details) {
            console.error('Get price API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from API
      const responseData: GetPriceResponse = await response.json();

      // Store parts_breakdown in localStorage for future checkout
      localStorage.setItem('current_parts_list', JSON.stringify(responseData.parts_breakdown));

      return responseData;

    } catch (error) {
      console.error('Get price request failed');
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Unknown error occurred during price fetch');
      }
    }
  }
}
