import { saveAiConsent } from '../src/utils/aiConsent';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetGenerationApiService, type GetGenerationResponse } from '../src/services/getGenerationApi';
import { GlbToBricksApiService } from '../src/services/glbToBricksApi';
import { ImageToBricksApiService } from '../src/services/imageToBricksApi';
import { TextToBricksApiService } from '../src/services/textToBricksApi';
import { GetGenerationsByImageApiService } from '../src/services/getGenerationsByImageApi';

const response = (data: unknown, ok = true, body?: ReadableStream) => ({
  ok, status: ok ? 200 : 400, statusText: ok ? 'OK' : 'Bad Request',
  json: vi.fn().mockResolvedValue(data), text: vi.fn().mockResolvedValue(JSON.stringify(data)), body,
});
const sse = (events: unknown[], options?: { crlf?: boolean; trailingDelimiter?: boolean }) => new ReadableStream({
  start(controller) {
    const delimiter = options?.crlf ? '\r\n\r\n' : '\n\n';
    const payload = events.map((event) => `data: ${JSON.stringify(event)}`).join(delimiter);
    const content = options?.trailingDelimiter === false ? payload : `${payload}${delimiter}`;
    controller.enqueue(new TextEncoder().encode(content));
    controller.close();
  },
});

// These service contracts run after the user has granted AI permission.
beforeEach(() => saveAiConsent(true));

describe('generation services', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));

  it('requests history by revision ID, including image-free LLM models', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({generations: [{id: 'edit', generation_id: 'root', version: 3}], total_count: 1}) as unknown as Response);
    const history = await GetGenerationsByImageApiService.getGenerationsByImage('token', 'revision');
    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({generation_id: 'revision'});
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(init?.headers).has('X-Guest-Session')).toBe(true);
    expect(history.generations[0].version).toBe(3);
  });

  it('posts cancellation with owner credentials and reports completed-job conflicts', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'cancelled' }) as unknown as Response);
    await GetGenerationApiService.cancelGeneration('job/one');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/generation/job%2Fone/cancel');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).has('X-Guest-Session')).toBe(true);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 409 } as Response);
    await expect(GetGenerationApiService.cancelGeneration('job')).rejects.toThrow('already finished');
  });

  it('explains network cancellation failures and allows a successful retry', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(GetGenerationApiService.cancelGeneration('job')).rejects.toThrow(
      'Unable to reach the server to cancel this build. Please try again.',
    );
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 'cancelled' }) as unknown as Response);
    await expect(GetGenerationApiService.cancelGeneration('job')).resolves.toBeUndefined();
  });

  it('stops polling a server-cancelled job and does not return a late result after abort', async () => {
    const base = { generation_id: 'g', status: 'cancelled', prompt: 'Castle', ldr_content: 'ldr' } as GetGenerationResponse;
    vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue(base);
    await expect(GetGenerationApiService.pollUntilComplete('g')).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    vi.mocked(GetGenerationApiService.getGeneration).mockImplementation(async () => {
      controller.abort();
      return { ...base, status: 'completed' };
    });
    const update = vi.fn();
    await expect(GetGenerationApiService.pollUntilComplete('g', update, 0, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(update).not.toHaveBeenCalled();
  });

  it('aborts polling during the wait and removes abort listeners', async () => {
    vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ generation_id: 'g', status: 'processing' } as GetGenerationResponse);
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const update = vi.fn();
    const pending = GetGenerationApiService.pollUntilComplete('g', update, 10000, 120, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(removed).toHaveBeenCalled();
  });

  it('sends the source generation and prompt for voxel edits with owner credentials', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ generation_id: 'edited', message: 'ok' }) as unknown as Response);
    await LlmToBricksApiService.generate({ sourceGenerationId: 'source', prompt: '  red roof  ' }, 'token');
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(String(url)).toContain('/llmToBricks');
    expect(JSON.parse(init?.body as string)).toMatchObject({ generation_id: 'source', prompt: 'red roof' });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer token');
    expect(new Headers(init?.headers).has('X-Guest-Session')).toBe(true);
  });

  it('starts image and text generations with defaults and authentication', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ generation_id: 'image', message: 'ok' }) as unknown as Response);
    await ImageToBricksApiService.generateBricksFromImage('pixels', 0.75, 'tok', 'a', 'c', '  owl  ');
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ image_base64: 'pixels', detail_level: 0.75, prompt: 'owl', model_option: 'a' });
    vi.mocked(fetch).mockResolvedValueOnce(response({ generation_id: 'text', message: 'ok' }) as unknown as Response);
    await TextToBricksApiService.generateBricksFromText('castle', 2, 'tok');
    expect(JSON.parse((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body as string)).toMatchObject({ prompt: 'castle', detail_level: 2, use_red_bricks: true });
  });

  it('parses streaming image and text completion events', async () => {
    const events = [{ stage: 'voxels', voxel_count: 2 }, { type: 'pipeline', stage: 'pipeline_complete', generation_id: 'g1' }];
    const onImageEvent = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(response({}, true, sse(events)) as unknown as Response);
    await expect(ImageToBricksApiService.generateBricksFromImageStream('pixels', 1, undefined, 'b', 'a', onImageEvent)).resolves.toMatchObject({ generation_id: 'g1' });
    expect(onImageEvent).toHaveBeenCalledTimes(2);
    vi.mocked(fetch).mockResolvedValueOnce(response({}, true, sse(events, { crlf: true, trailingDelimiter: false })) as unknown as Response);
    await expect(ImageToBricksApiService.generateBricksFromImageStream('pixels')).resolves.toMatchObject({ generation_id: 'g1' });
    vi.mocked(fetch).mockResolvedValueOnce(response({}, true, sse(events)) as unknown as Response);
    await expect(TextToBricksApiService.generateBricksFromTextStream('castle')).resolves.toMatchObject({ generation_id: 'g1' });
  });

  it('rejects missing inputs and streams without completion', async () => {
    await expect(ImageToBricksApiService.generateBricksFromImage('')).rejects.toThrow('image_base64 is required');
    await expect(TextToBricksApiService.generateBricksFromTextStream('')).rejects.toThrow('prompt is required');
    vi.mocked(fetch).mockResolvedValueOnce(response({}, true, sse([{ type: 'pipeline', stage: 'working' }])) as unknown as Response);
    await expect(TextToBricksApiService.generateBricksFromTextStream('castle')).rejects.toThrow('pipeline_complete');
  });

  it('uploads GLB form data and creates BrickOwl wishlists', async () => {
    const file = new File(['glb'], 'model.glb');
    vi.mocked(fetch).mockResolvedValueOnce(response({ generation_id: 'g', message: 'ok' }) as unknown as Response);
    await GlbToBricksApiService.uploadGlb(file, 'obj2voxel', 32, 'tok');
    const form = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.get('file')).toBe(file);
    expect(form.get('voxelizer')).toBe('obj2voxel');
    vi.mocked(fetch).mockResolvedValueOnce(response({ success: true, message: 'ok' }) as unknown as Response);
    await ImageToBricksApiService.createBrickOwlWishlist('ldr', 'key', 'me@example.com', 'tok');
    expect(JSON.parse((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body as string)).toMatchObject({ ldr_content: 'ldr', brickowl_api_key: 'key' });
  });

  it('gets and polls a generation through completion', async () => {
    const processing: GetGenerationResponse = { generation_id: 'g', status: 'processing', prompt: null, external_image_url: null, processed_image_url: null, detail_level: 1, ldr_content: null, mpd_url: null, xyzrgb_url: null, problematic_xyzrgb_url: null, error_message: null };
    const completed = { ...processing, status: 'completed' as const, prompt: 'castle', ldr_content: 'ldr' };
    vi.mocked(fetch).mockResolvedValueOnce(response(processing) as unknown as Response).mockResolvedValueOnce(response(completed) as unknown as Response);
    const callback = vi.fn();
    await expect(GetGenerationApiService.pollUntilComplete('g', callback, 0, 2)).resolves.toMatchObject({ generation_id: 'g', ldr_content: 'ldr' });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[0][0]).endsWith('/generation/g')).toBe(true);
  });

  it('reports failed, invalid, timed-out, and aborted polling', async () => {
    const base = { generation_id: 'g', prompt: null, external_image_url: null, processed_image_url: null, detail_level: null, ldr_content: null, mpd_url: null, xyzrgb_url: null, problematic_xyzrgb_url: null };
    vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ ...base, status: 'failed', error_message: 'boom' });
    await expect(GetGenerationApiService.pollUntilComplete('g')).rejects.toThrow('boom');
    vi.mocked(GetGenerationApiService.getGeneration).mockResolvedValue({ ...base, status: 'processing', error_message: null });
    await expect(GetGenerationApiService.pollUntilComplete('g', undefined, 0, 1)).rejects.toThrow('timed out');
    const controller = new AbortController(); controller.abort();
    await expect(GetGenerationApiService.pollUntilComplete('g', undefined, 0, 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('preserves the saved model title when returning a completed polling result', async () => {
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({
    generation_id: 'g', status: 'completed', name: 'Moon Rover', prompt: 'please make a rover', ldr_content: 'ldr',
  } as GetGenerationResponse);
  expect(await GetGenerationApiService.pollUntilComplete('g')).toMatchObject({name: 'Moon Rover', prompt: 'please make a rover'});
});
