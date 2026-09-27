import { apiFetch } from './apiFetch';
// Response from async POST endpoint (initiates generation)
export interface ImageToBricksResponse {
  generation_id: string;
  message: string;
}

// --- Streaming SSE event types ---

// Phase 1: SAM3D 3D generation events
export interface GeometryEvent {
  type: 'geometry' | 'appearance';
  progress?: number;
  step?: number;
  total_steps?: number;
  bounds?: unknown;
  [key: string]: unknown; // base64 voxel data etc.
}

export interface MeshPreviewEvent {
  type: 'mesh_preview';
  vertices_data: string;   // base64
  faces_data: string;      // base64
  vertex_colors_data: string; // base64
}

export interface GlbReadyEvent {
  type: 'glb_ready';
  glb_data: string; // base64-encoded GLB
}

// Voxel data event — sent by server with stage field (not type)
export interface VoxelDataEvent {
  stage: 'geometry' | 'appearance';
  step?: number;
  total_steps?: number;
  progress?: number;
  voxel_data: string;     // base64-encoded binary_uint8_xyzrgb
  encoding?: string;      // e.g. 'binary_uint8_xyzrgb'
  voxel_count?: number;
  bounds_min?: [number, number, number];
  bounds_max?: [number, number, number];
}

export interface Sam3dCompleteEvent {
  type: 'complete';
  model_glb_url?: string;
  gaussian_splat_url?: string;
}

export interface Sam3dErrorEvent {
  type: 'error';
  message?: string;
  error?: string;
}

// Pre-SAM3D pipeline events (text-to-bricks image generation)
export interface ImageGenerationEvent {
  type: 'pipeline';
  stage: 'image_generation';
  status: 'submitting' | 'queued' | 'processing' | 'completed';
  message?: string;
  queue_position?: number;
  progress?: number;
}

export interface BackgroundRemovalEvent {
  type: 'pipeline';
  stage: 'background_removal';
  message?: string;
  progress?: number; // 0 or 100
  image_url?: string; // present when progress is 100
}

export interface InputProcessedEvent {
  type: 'pipeline';
  stage: 'input_processed';
  message?: string;
  image_url?: string;
}

// Phase 2: Brick pipeline events
export interface PipelineEvent {
  type: 'pipeline';
  stage: 'image_generation' | 'background_removal' | 'input_processed' | 'brick_conversion' | 'brick_packing' | 'storage' | 'pipeline_complete' | 'error';
  message?: string;
  progress?: number;
  brick_count?: number;
  generation_id?: string; // present on pipeline_complete
  // image_generation fields
  status?: string;
  queue_position?: number;
  // background_removal / input_processed fields
  image_url?: string;
}

export type StreamEvent =
  | GeometryEvent
  | MeshPreviewEvent
  | GlbReadyEvent
  | VoxelDataEvent
  | Sam3dCompleteEvent
  | Sam3dErrorEvent
  | ImageGenerationEvent
  | BackgroundRemovalEvent
  | InputProcessedEvent
  | PipelineEvent;

export interface LdrToBrickOwlResponse {
  success: boolean;
  message: string;
  wishlist_id?: string;
  wishlist_url?: string;
  total_parts?: number;
  unique_parts?: number;
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
      imageToBricks: `${LOCAL_API_URL}/imageToBricks`,
      ldrToBrickOwl: `${LOCAL_API_URL}/ldrToBrickOwl`,
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      imageToBricks: `${RAILWAY_API_URL_STAGING}/imageToBricks`,
      ldrToBrickOwl: `${RAILWAY_API_URL_STAGING}/ldrToBrickOwl`,
    };
  } else {
    return {
      imageToBricks: `${RAILWAY_API_URL}/imageToBricks`,
      ldrToBrickOwl: `${RAILWAY_API_URL}/ldrToBrickOwl`,
    };
  }
};

const API_URLS = getApiUrls();
const LOCAL_DEV_API_KEY = import.meta.env.DEV && API_MODE === 'local'
  ? import.meta.env.VITE_BACKEND_API_KEY
  : undefined;

export class ImageToBricksApiService {
  static async generateBricksFromImage(imageBase64: string, voxelSize: number = 0.5, authToken?: string, modelOption: string = 'b', promptOption: string = 'a', prompt?: string): Promise<ImageToBricksResponse> {
    console.log(`Sending image to bricks request to backend`);
    
    if (!imageBase64) {
      throw new Error('image_base64 is required');
    }

    console.log('Processing image to server API, image size:', imageBase64.length);

    // Prepare headers for Railway API request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add authentication headers if present
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      console.log('Adding Authorization header');
    }

    try {
      // Forward request to API
      const response = await apiFetch(API_URLS.imageToBricks, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          image_base64: imageBase64,
          detail_level: voxelSize,
          edit_image: true,
          model_option: modelOption,
          prompt_option: promptOption,
          prompt: prompt?.trim() || undefined,
          use_red_bricks: true
        }),
      });

      //console.log(`API response status:`, response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Server API error:', errorText);
        
        let errorMessage = 'Failed to generate brick model';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
          if (errorData.details) {
            console.error('API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from API (returns generation_id and message)
      const responseData: ImageToBricksResponse = await response.json();
      console.log('Received response data:', {
        message: responseData.message,
        generation_id: responseData.generation_id
      });

      // Validate the response structure
      if (!responseData.generation_id) {
        console.error('Invalid response: missing generation_id');
        throw new Error('Invalid response from server: missing generation_id');
      }

      return responseData;

    } catch (error) {
      console.error('Image API error:', error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Internal server error');
      }
    }
  }

  /**
   * Streaming variant of generateBricksFromImage.
   * Sends `stream: true` and reads the SSE response, logging every event.
   * Calls `onEvent` for each parsed SSE event so callers can react in real-time.
   * Returns the generation_id from the final `pipeline_complete` event.
   */
  static async generateBricksFromImageStream(
    imageBase64: string,
    voxelSize: number = 0.5,
    authToken?: string,
    modelOption: string = 'b',
    promptOption: string = 'a',
    onEvent?: (event: StreamEvent) => void,
    stream3d: boolean = true,
    voxelizer: string = 'trimesh',
    prompt?: string,
  ): Promise<ImageToBricksResponse> {
    console.log('[stream] Sending streaming image-to-bricks request');

    if (!imageBase64) {
      throw new Error('image_base64 is required');
    }

    console.log('[stream] Image size:', imageBase64.length);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      console.log('[stream] Adding Authorization header');
    }

    const response = await apiFetch(API_URLS.imageToBricks, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image_base64: imageBase64,
        detail_level: voxelSize,
        edit_image: true,
        model_option: modelOption,
        prompt_option: promptOption,
        prompt: prompt?.trim() || undefined,
        use_red_bricks: true,
        stream: true,
        stream_3d: stream3d,
        voxelizer: voxelizer,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[stream] Server API error:', errorText);

      let errorMessage = 'Failed to generate brick model';
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
    const processSseEvent = (rawEvent: string) => {
      const event = rawEvent.trim();
      if (!event) return;

      const dataLines = event
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''));

      if (dataLines.length === 0) return;

      const jsonStr = dataLines.join('\n');
      let data: StreamEvent;
      try {
        data = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.warn('[stream] Failed to parse SSE event JSON:', jsonStr, parseErr);
        return;
      }

      // --- Log every event ---
      // Check for voxel data events first (have 'stage' but no 'type')
      if ('stage' in data && !('type' in data)) {
        const ve = data as VoxelDataEvent;
        console.log(
          `[stream][voxel] stage=${ve.stage} step=${ve.step ?? '-'}/${ve.total_steps ?? '-'} progress=${ve.progress ?? '-'} voxels=${ve.voxel_count ?? '-'}`,
        );
        onEvent?.(ve as unknown as StreamEvent);
        return;
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
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        // Process all complete SSE events in the buffer
        while (buffer.includes('\n\n')) {
          const delimiterIndex = buffer.indexOf('\n\n');
          const event = buffer.slice(0, delimiterIndex);
          buffer = buffer.slice(delimiterIndex + 2);
          processSseEvent(event);
        }
      }

      if (buffer.trim()) {
        processSseEvent(buffer);
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

  // Create BrickOwl wishlist from LDR content
  static async createBrickOwlWishlist(ldrContent: string, brickOwlApiKey: string, userEmail: string, authToken?: string): Promise<LdrToBrickOwlResponse> {
    console.log(`Sending BrickOwl wishlist request to backend`);
    
    if (!ldrContent) {
      throw new Error('LDR content is required');
    }

    if (!brickOwlApiKey) {
      throw new Error('BrickOwl API key is required');
    }

    if (!userEmail) {
      throw new Error('User email is required');
    }

    console.log('Processing BrickOwl wishlist creation, LDR size:', ldrContent.length);

    // Prepare headers for API request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (LOCAL_DEV_API_KEY) {
      headers['X-API-Key'] = LOCAL_DEV_API_KEY;
    }

    // Add authentication headers if present
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
      console.log('Adding Authorization header');
    }

    try {
      // Forward request to API
      const response = await apiFetch(API_URLS.ldrToBrickOwl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ldr_content: ldrContent,
          brickowl_api_key: brickOwlApiKey,
          user_email: userEmail
        }),
      });

      //console.log(`API response status:`, response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Server API error:', errorText);
        
        let errorMessage = 'Failed to create BrickOwl wishlist';
        try {
          const errorData = JSON.parse(errorText);
          errorMessage = errorData.error || errorData.detail || `API error: ${response.status} ${response.statusText}`;
          if (errorData.details) {
            console.error('API error details:', errorData.details);
          }
        } catch (parseError) {
          // If it's not JSON, use the raw text
          errorMessage = errorText || `${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      // Get the JSON response from backend API
      const responseText = await response.text();
      console.log('Raw BrickOwl response:', responseText);
      
      let responseData: LdrToBrickOwlResponse;
      try {
        const rawData = JSON.parse(responseText);
        
        // Map the backend response to our expected interface
        responseData = {
          success: true, // If we get here, it was successful
          message: rawData.message || 'Successfully created BrickOwl wishlist',
          wishlist_id: rawData.wishlist_id,
          wishlist_url: rawData.brickowl_url, // Backend uses 'brickowl_url', frontend expects 'wishlist_url'
          total_parts: rawData.parts_count, // Backend uses 'parts_count', frontend expects 'total_parts'
          unique_parts: rawData.unique_parts
        };
      } catch (parseError) {
        console.error('Failed to parse BrickOwl response as JSON:', parseError);
        // If it's not JSON, assume it's a success message
        responseData = {
          success: true,
          message: responseText,
          total_parts: undefined,
          unique_parts: undefined
        };
      }
      
      // console.log('Parsed BrickOwl response data:', {
      //   success: responseData.success,
      //   message: responseData.message,
      //   wishlist_id: responseData.wishlist_id,
      //   wishlist_url: responseData.wishlist_url,
      //   total_parts: responseData.total_parts,
      //   unique_parts: responseData.unique_parts
      // });

      return responseData;

    } catch (error) {
      console.error('BrickOwl API request failed:', error);
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error('Unknown error occurred during BrickOwl wishlist creation');
      }
    }
  }
}
