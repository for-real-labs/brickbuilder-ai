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
export interface UpdateImagePreviewRequest {
  generation_id: string;
  // Base64-encoded PNG/JPEG image. Accepts raw base64 or a data URI
  // (e.g. "data:image/png;base64,iVBORw0...").
  image_base64: string;
}

export interface UpdateImagePreviewResponse {
  generation_id: string;
  preview_image_url: string;
}

export class UpdateImagePreviewApiService {
  /**
   * Upload a preview image for a generation. Only the authenticated owner of
   * the generation can update its preview image.
   */
  static async updateImagePreview(
    generationId: string,
    imageBase64: string,
    accessToken: string,
  ): Promise<UpdateImagePreviewResponse> {
    const url = `${API_BASE_URL}/updateImagePreview`;

    const requestBody: UpdateImagePreviewRequest = {
      generation_id: generationId,
      image_base64: imageBase64,
    };

    const response = await apiFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`UpdateImagePreview API error: ${response.status} - ${errorText}`);
    }

    const data: UpdateImagePreviewResponse = await response.json();
    return data;
  }
}
