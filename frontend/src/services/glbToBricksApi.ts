import { apiFetch } from './apiFetch';
// API service for uploading a GLB file and converting it to bricks via glb2brick.

export interface GlbToBricksResponse {
  generation_id: string;
  message: string;
}

const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

const getBaseUrl = (): string => {
  if (API_MODE === 'railway_staging') return RAILWAY_API_URL_STAGING;
  if (API_MODE === 'railway') return RAILWAY_API_URL;
  return LOCAL_API_URL;
};

export class GlbToBricksApiService {
  /**
   * Upload a GLB file and start a brick conversion.
   * Returns the generation_id; poll GET /generation/{id} for status.
   */
  static async uploadGlb(
    file: File,
    voxelizer: 'trimesh' | 'obj2voxel' = 'trimesh',
    detailLevel: number = 40,
    authToken?: string,
  ): Promise<GlbToBricksResponse> {
    if (!file) {
      throw new Error('A GLB file is required');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('voxelizer', voxelizer);
    formData.append('detail_level', String(detailLevel));

    const headers: Record<string, string> = {};
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    const response = await apiFetch(`${getBaseUrl()}/glbToBricks`, {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!response.ok) {
      let errorMessage = 'Failed to convert GLB to bricks';
      try {
        const errorText = await response.text();
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.detail || errorData.error || errorMessage;
        } catch {
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
      } catch {
        errorMessage = `${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    const data: GlbToBricksResponse = await response.json();
    if (!data.generation_id) {
      throw new Error('Invalid response: missing generation_id');
    }
    return data;
  }
}
