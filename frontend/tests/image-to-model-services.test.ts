import { beforeEach, expect, it, vi } from 'vitest';
import { ImageToBricksApiService } from '../src/services/imageToBricksApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { startImageModel, waitForImageModel, downloadImageModel } from '../src/services/imageToModel';
import { getAnonymousGenerationIds } from '../src/utils/anonGenerations';

beforeEach(() => localStorage.clear());

it('reuses imageToBricks with image editing off and preserves anonymous ownership', async () => {
  const generate = vi.spyOn(ImageToBricksApiService, 'generateBricksFromImage').mockResolvedValue({ generation_id: 'guest-id', message: 'queued' });
  expect(await startImageModel(new File(['image'], 'photo.png', { type: 'image/png' }))).toBe('guest-id');
  expect(generate).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), 1.6, undefined, 'b', 'a', undefined, false);
  expect(getAnonymousGenerationIds()).toContain('guest-id');
});

it('reads the mesh from the authorized generation polling response', async () => {
  const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockResolvedValue({ glb_url: 'https://storage.example/model.glb' } as never);
  const signal = new AbortController().signal;
  const status = vi.fn();
  expect(await waitForImageModel('id', signal, status)).toBe('https://storage.example/model.glb');
  expect(poll).toHaveBeenCalledWith('id', status, 2500, 360, signal);
  poll.mockResolvedValueOnce({} as never);
  await expect(waitForImageModel('id', signal, status)).rejects.toThrow('no downloadable');
  poll.mockResolvedValueOnce({ glb_url: 'javascript:alert(1)' } as never);
  await expect(waitForImageModel('id', signal, status)).rejects.toThrow('URL is invalid');
});

it('downloads model storage without forwarding API credentials', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
  const signal = new AbortController().signal;
  const result = await downloadImageModel('https://storage.example/model.glb', signal);
  expect(result.name).toBe('image-model.glb');
  expect(result.size).toBe(3);
  expect(fetcher).toHaveBeenCalledWith('https://storage.example/model.glb', { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
});

it('rejects failed, oversized, and empty storage downloads', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const signal = new AbortController().signal;
  fetcher.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
  await expect(downloadImageModel('https://storage.example/model.glb', signal)).rejects.toThrow('Could not download');
  fetcher.mockResolvedValueOnce(new Response('mesh', { headers: { 'Content-Length': String(51 * 1024 * 1024) } }));
  await expect(downloadImageModel('https://storage.example/model.glb', signal)).rejects.toThrow('50 MB');
  fetcher.mockResolvedValueOnce(new Response(new Uint8Array()));
  await expect(downloadImageModel('https://storage.example/model.glb', signal)).rejects.toThrow('empty');
});
