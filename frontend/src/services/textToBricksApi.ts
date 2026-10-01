import { apiFetch } from './apiFetch';
import type {
  StreamEvent,
  VoxelDataEvent,
  GeometryEvent,
  MeshPreviewEvent,
  Sam3dCompleteEvent,
  Sam3dErrorEvent,
  PipelineEvent,
} from './imageToBricksApi';

export type { StreamEvent };

export interface GenerationResponse {
  task_id?: string;
  mpd_content?: string;
}

// Response from async POST endpoint (initiates generation)
export interface TextToBricksResponse {
  generation_id: string;
  message: string;
}

export interface StatusResponse {
  task_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
  generation_time?: number;
  num_bricks?: number;
  num_rejections?: number;
  num_regenerations?: number;
  files?: {
    txt: string;
    ldr: string;
  };
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
      textToBricks: `${LOCAL_API_URL}/textToBricks`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      textToBricks: `${RAILWAY_API_URL_STAGING}/textToBricks`,
    };
  } else {
    return {
      textToBricks: `${RAILWAY_API_URL}/textToBricks`,
    };
  }
};

const API_URLS = getApiUrls();

export class TextToBricksApiService {
  // Text-to-bricks generation method
  static async generateBricksFromText(prompt: string, voxelSize: number = 1.0, authToken?: string, modelOption: string = 'b', promptOption: string = 'a'): Promise<TextToBricksResponse> {
    console.log(`Sending text to bricks request to backend`);
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    // Add authentication header if token provided
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const response = await apiFetch(API_URLS.textToBricks, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: prompt,
        detail_level: voxelSize,
        model_option: modelOption,
        prompt_option: promptOption,
        use_red_bricks: true
      }),
    });

    //console.log(`Text API response status:`, response.status);

    if (!response.ok) {
      let errorMessage = 'Failed to generate brick model from text';
      try {
        // Try to get the response text first, then parse as JSON if possible
        const errorText = await response.text();
        console.error('Text generation error response:', errorText);
        
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || errorMessage;
          if (errorData.details) {
            console.error('API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
      } catch (e) {
        console.error('Failed to read error response:', e);
        errorMessage = `${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    // The API returns JSON with generation_id and message
    const responseData: TextToBricksResponse = await response.json();
    console.log('Text API response received:', {
      message: responseData.message,
      generation_id: responseData.generation_id
    });
    
    // Validate the response structure
    if (!responseData.generation_id) {
      throw new Error('Invalid response: missing generation_id');
    }

    return responseData;
  }

  /**
   * Streaming variant of generateBricksFromText.
   * Sends `stream: true` and reads the SSE response.
   * Calls `onEvent` for each parsed SSE event so callers can react in real-time.
   * Returns the generation_id from the final `pipeline_complete` event.
   */
  static async generateBricksFromTextStream(
    prompt: string,
    voxelSize: number = 1.0,
    authToken?: string,
    modelOption: string = 'b',
    promptOption: string = 'a',
    onEvent?: (event: StreamEvent) => void,
    stream3d: boolean = true,
    voxelizer: string = 'trimesh',
    signal?: AbortSignal,
  ): Promise<TextToBricksResponse> {
    console.log('[stream] Sending streaming text-to-bricks request');

    if (!prompt) {
      throw new Error('prompt is required');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      console.log('[stream] Adding Authorization header');
    }

    const response = await apiFetch(API_URLS.textToBricks, {
      method: 'POST',
      signal,
      headers,
      body: JSON.stringify({
        prompt: prompt,
        detail_level: voxelSize,
        model_option: modelOption,
        prompt_option: promptOption,
        use_red_bricks: true,
        stream: true,
        stream_3d: stream3d,
        voxelizer: voxelizer,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[stream] Server API error:', errorText);

      let errorMessage = 'Failed to generate brick model from text';
      try {
        const errorData = JSON.parse(errorText);
        errorMessage =
          errorData.error ||
          errorData.detail ||
          `API error: ${response.status} ${response.statusText}`;
      } catch {
        errorMessage = errorText || `${response.status} ${response.statusText}`;
      }
      throw new Error(errorMessage);
    }

    if (!response.body) {
      throw new Error('Response body is null — streaming not supported by browser');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let generationId: string | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process all complete SSE events in the buffer
        while (buffer.includes('\n\n')) {
          const delimiterIndex = buffer.indexOf('\n\n');
          const event = buffer.slice(0, delimiterIndex);
          buffer = buffer.slice(delimiterIndex + 2);

          if (!event.startsWith('data: ')) continue;

          const jsonStr = event.slice(6);
          let data: StreamEvent;
          try {
            data = JSON.parse(jsonStr);
          } catch (parseErr) {
            console.warn('[stream] Failed to parse SSE event JSON:', jsonStr, parseErr);
            continue;
          }

          // Check for voxel data events first (have 'stage' but no 'type')
          if ('stage' in data && !('type' in data)) {
            const ve = data as VoxelDataEvent;
            console.log(
              `[stream][voxel] stage=${ve.stage} step=${ve.step ?? '-'}/${ve.total_steps ?? '-'} progress=${ve.progress ?? '-'} voxels=${ve.voxel_count ?? '-'}`,
            );
            onEvent?.(ve as unknown as StreamEvent);
            continue;
          }

          // All remaining events have a 'type' field
          const typed = data as Exclude<StreamEvent, VoxelDataEvent>;

          if (typed.type === 'pipeline') {
            const pe = typed as PipelineEvent;

            if (pe.stage === 'image_generation') {
              console.log(
                `[stream][image_generation] status=${pe.status ?? '-'} message=${pe.message ?? '-'} queue_position=${pe.queue_position ?? '-'}`,
              );
            } else if (pe.stage === 'background_removal') {
              console.log(
                `[stream][background_removal] progress=${pe.progress ?? '-'} message=${pe.message ?? '-'} image_url=${pe.image_url ? 'present' : '-'}`,
              );
            } else if (pe.stage === 'input_processed') {
              console.log(
                `[stream][input_processed] message=${pe.message ?? '-'} image_url=${pe.image_url ? 'present' : '-'}`,
              );
            } else {
              console.log(
                `[stream][pipeline] stage=${pe.stage} progress=${pe.progress ?? '-'} message=${pe.message ?? '-'}`,
                pe.stage === 'pipeline_complete' ? `generation_id=${pe.generation_id}` : '',
                pe.stage === 'brick_conversion' && pe.brick_count != null ? `brick_count=${pe.brick_count}` : '',
              );
            }

            if (pe.stage === 'pipeline_complete' && pe.generation_id) {
              generationId = pe.generation_id;
            }

            if (pe.stage === 'error') {
              throw new Error(pe.message || 'Pipeline error');
            }
          } else if (typed.type === 'geometry' || typed.type === 'appearance') {
            const ge = typed as GeometryEvent;
            console.log(
              `[stream][sam3d] type=${ge.type} step=${ge.step ?? '-'}/${ge.total_steps ?? '-'} progress=${ge.progress ?? '-'}`,
            );
          } else if (typed.type === 'mesh_preview') {
            console.log('[stream][sam3d] mesh_preview received (vertices, faces, vertex_colors)');
          } else if (typed.type === 'glb_ready') {
            console.log('[stream][sam3d] glb_ready — GLB data received');
          } else if (typed.type === 'complete') {
            const ce = typed as Sam3dCompleteEvent;
            console.log('[stream][sam3d] complete', {
              model_glb_url: ce.model_glb_url,
              gaussian_splat_url: ce.gaussian_splat_url,
            });
          } else if (typed.type === 'error') {
            const ee = typed as Sam3dErrorEvent;
            console.error('[stream][sam3d] error:', ee.message || ee.error);
            throw new Error(ee.message || ee.error || 'SAM3D error');
          } else {
            console.log('[stream] unknown event type:', data);
          }

          // Notify caller
          onEvent?.(data);
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!generationId) {
      throw new Error('Stream ended without receiving pipeline_complete event');
    }

    console.log('[stream] Stream complete. generation_id:', generationId);

    return {
      generation_id: generationId,
      message: 'Streaming generation complete',
    };
  }
}