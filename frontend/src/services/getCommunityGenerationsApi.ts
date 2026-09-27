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
export interface CommunityGeneration {
  id: string;
  user_id: string;
  user_type: string;
  prompt: string;
  name?: string | null;
  detail_level: number;
  endpoint: string;
  created_at: string;
  status: string;
  ldr_url?: string | null;
  xyzrgb_url?: string | null;
  parts_list_csv_url?: string | null;
  original_image_url?: string | null;
  processed_image_url?: string | null;
  external_image_url?: string | null;
  external_glb_url?: string | null;
  preview_image_url?: string | null;
  model_used_image?: string | null;
  model_used_3d?: string | null;
  ordered?: boolean;
  updated_at?: string | null;
  is_community?: boolean;
  like_count?: number;
  viewer_has_liked?: boolean;
  username?: string | null;
  // Some clients/UIs may expect these — keep optional for compatibility
  image_url?: string | null;
  thumbnail_url?: string | null;
}

export interface GetCommunityGenerationsRequest {
  limit?: number;
  offset?: number;
  processing?: boolean;
  sort?: 'recent' | 'top';
}

export interface GetCommunityGenerationsResponse {
  generations: CommunityGeneration[];
  total_count: number;
  has_more: boolean;
}

export class GetCommunityGenerationsApiService {
  static async getCommunityGenerations(
    authToken: string | undefined,
    limit: number = 50,
    offset: number = 0,
    processing?: boolean,
    sort: 'recent' | 'top' = 'recent'
  ): Promise<GetCommunityGenerationsResponse> {
    const url = `${API_BASE_URL}/getCommunityGenerations`;

    const requestBody: GetCommunityGenerationsRequest = {
      limit,
      offset,
      ...(processing !== undefined && { processing }),
      sort,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `API request failed: ${response.status} ${response.statusText}. ${errorText}`
        );
      }

      const data: GetCommunityGenerationsResponse = await response.json();
      return data;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to fetch community generations: ${String(error)}`);
    }
  }
}
