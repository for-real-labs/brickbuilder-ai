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

// Types matching the backend response
export interface OrderInfo {
  id?: number;
  generation_id: string;
  amount_paid?: string;
  stripe_session_id?: string;
  brickowl_cart_id?: string;
  brickowl_cart_url?: string;
  brickowl_wishlist_name?: string;
  fulfilled?: boolean;
  created_at?: string;
  image_url?: string;
  prompt?: string;
}

export interface GenerationWithOrder {
  id: string;
  generation_id?: string;
  version?: number;
  user_id: string;
  user_type: string;
  prompt: string;
  name?: string | null;
  detail_level: number;
  endpoint: string;
  created_at: string;
  status: string;
  ldr_url?: string;
  xyzrgb_url?: string;
  image_url?: string;
  thumbnail_url?: string;
  external_image_url?: string;
  processed_image_url?: string;
  preview_image_url?: string;
  previous_completed_generation_id?: string | null;
  previous_completed_preview_image_url?: string | null;
  model_used_image?: string;
  model_used_3d?: string;
  ordered?: boolean;
  updated_at?: string;
  order?: OrderInfo;
}

export interface GetUserGenerationsRequest {
  limit?: number;
  offset?: number;
  processing?: boolean;
}

export interface GetUserGenerationsResponse {
  generations: GenerationWithOrder[];
  total_count: number;
  total_user_generations: number;
  all_orders: OrderInfo[];
  has_more: boolean;
}

export class GetUserGenerationsApiService {
  static async getProcessingGenerations(authToken?: string, signal?: AbortSignal): Promise<GenerationWithOrder[]> {
    const generations = new Map<string, GenerationWithOrder>();
    let offset = 0;
    while (true) {
      const page = await this.getUserGenerations(authToken, 50, offset, true, signal);
      for (const generation of page.generations) generations.set(generation.id, generation);
      if (!page.has_more || page.generations.length === 0) break;
      offset += page.generations.length;
    }
    return [...generations.values()];
  }

  static async getUserGenerations(
    authToken: string | undefined,
    limit: number = 50,
    offset: number = 0,
    processing?: boolean,
    signal?: AbortSignal,
  ): Promise<GetUserGenerationsResponse> {
    const url = `${API_BASE_URL}/getUserGenerations`;

    const requestBody: GetUserGenerationsRequest = {
      limit,
      offset,
      ...(processing !== undefined && { processing }),
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
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API request failed: ${response.status} ${response.statusText}. ${errorText}`);
      }

      const data: GetUserGenerationsResponse = await response.json();
      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch user generations: ${String(error)}`);
    }
  }
}
