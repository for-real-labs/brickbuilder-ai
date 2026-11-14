import { afterEach, expect, it, vi } from 'vitest';
import { recognizeParts } from '../src/services/brickognizeApi';
import { prepareImageUpload } from '../src/utils/prepareImageUpload';

vi.mock('../src/utils/prepareImageUpload', () => ({ prepareImageUpload: vi.fn(async (file: File) => file) }));
const file = new File(['photo'], 'brick.jpg', { type: 'image/jpeg' });
const signal = () => new AbortController().signal;
const item = { id: '3001', name: 'Brick 2 x 4', type: 'part', score: 0.95, img_url: 'https://storage.googleapis.com/brickognize-static/thumbnails/3001.webp' };
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

it('uploads the prepared photo using the documented field without account credentials', async () => {
  const converted = new File(['converted'], 'brick.png', { type: 'image/png' });
  vi.mocked(prepareImageUpload).mockResolvedValueOnce(converted);
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [item] }) });
  vi.stubGlobal('fetch', fetcher);
  expect(await recognizeParts(file, signal())).toEqual([{ id: '3001', name: 'Brick 2 x 4', score: 0.95, imageUrl: item.img_url }]);
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toBe('https://api.brickognize.com/predict/parts/');
  expect(options.body.get('query_image')).toBe(converted);
  expect(options.credentials).toBe('omit');
  expect(options.headers).toBeUndefined();
});

it('filters invalid and duplicate candidates, sorts matches and rejects unsafe thumbnails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [
    { ...item, score: 0.6 }, item, { ...item, id: '3002', score: 0.8, img_url: 'https://untrusted.example/a.png' },
    { ...item, type: 'set' }, { ...item, id: '../bad' }, { ...item, score: 4 }, { ...item, name: '' }, null,
  ] }) }));
  const result = await recognizeParts(file, signal());
  expect(result.map(p => p.id)).toEqual(['3001', '3002']);
  expect(result[1].imageUrl).toBeNull();
});

it.each([[429, 'busy'], [500, 'could not recognize']])('explains HTTP %s failures', async (status, message) => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
  await expect(recognizeParts(file, signal())).rejects.toThrow(message);
});

it('handles empty results and malformed responses', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ items: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetcher);
  expect(await recognizeParts(file, signal())).toEqual([]);
  await expect(recognizeParts(file, signal())).rejects.toThrow('unreadable');
});

it('does not upload rejected images or images cancelled during conversion', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  vi.mocked(prepareImageUpload).mockRejectedValueOnce(new Error('This image is empty.'));
  await expect(recognizeParts(file, signal())).rejects.toThrow('empty');
  const controller = new AbortController(); controller.abort();
  await expect(recognizeParts(file, controller.signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it('aborts outstanding requests when leaving the screen', async () => {
  const fetcher = vi.fn().mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const result = recognizeParts(file, controller.signal);
  const assertion = expect(result).rejects.toThrow('Aborted');
  await Promise.resolve(); controller.abort();
  await assertion;
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
});

it('times out a stalled service and explains network failures', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  })));
  const result = recognizeParts(file, signal());
  const assertion = expect(result).rejects.toThrow('took too long');
  await vi.advanceTimersByTimeAsync(45_000); await assertion;
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(recognizeParts(file, signal())).rejects.toThrow('connection');
});
