// API Configuration
const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

const API_BASE_URL = API_MODE === 'local'
  ? LOCAL_API_URL
  : API_MODE === 'railway_staging'
    ? RAILWAY_API_URL_STAGING
    : RAILWAY_API_URL;

export interface GenerationStats {
  generation_count: number;
  brick_count: number;
}

export class GetGenerationStatsApiService {
  static async getGenerationStats(signal?: AbortSignal): Promise<GenerationStats> {
    const response = await fetch(import.meta.env.VITE_GENERATION_STATS_API_URL || `${API_BASE_URL}/generation-stats`, { signal });

    if (!response.ok) {
      throw new Error(`Failed to load generation stats: ${response.status}`);
    }

    return response.json() as Promise<GenerationStats>;
  }
}
