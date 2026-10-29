import { beforeEach, expect, it, vi } from 'vitest';
import { PartsInventoryApi, inventoryQuantity } from '../src/services/partsInventoryApi';
import { NovaToBricksApiService, DEFAULT_NOVA_OPTIONS } from '../src/services/novaToBricksApi';
import { apiFetch } from '../src/services/apiFetch';
vi.mock('../src/services/apiFetch', () => ({ apiFetch: vi.fn(), authenticatedApiFetch: vi.fn() }));
const response = (data: unknown, ok = true) => ({ ok, json: async () => data }) as Response;
beforeEach(() => vi.clearAllMocks());
const inventory = { name: 'box.csv', source: 'upload' as const, parts: [{ part_id: '3001', color_id: 4, quantity: 3 }] };
it('uploads multipart and preserves normalized quantity data', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ inventory, unavailable: [] }));
  const file = new File(['data'], 'box.csv');
  expect((await PartsInventoryApi.upload(file)).inventory).toEqual(inventory);
  expect((vi.mocked(apiFetch).mock.calls[0][1]?.body as FormData).get('file')).toBe(file);
  expect(inventoryQuantity(inventory)).toBe(3);
});
it('rejects large files before transport', async () => {
  const file = new File([], 'box.csv'); Object.defineProperty(file, 'size', { value: 17 * 1024 * 1024 });
  await expect(PartsInventoryApi.upload(file)).rejects.toThrow('16 MB'); expect(apiFetch).not.toHaveBeenCalled();
});
it('encodes searches and loads a selected set', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce(response({ sets: [{ set_num: '123-1' }] })).mockResolvedValueOnce(response({ inventory, unavailable: [] }));
  expect(await PartsInventoryApi.search(' Castle & trees ')).toEqual([{ set_num: '123-1' }]);
  expect(vi.mocked(apiFetch).mock.calls[0][0]).toContain('q=Castle%20%26%20trees');
  expect((await PartsInventoryApi.select('123-1')).inventory).toEqual(inventory);
});
it('shows server errors and handles non-json failures', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ detail: 'Unavailable' }, false));
  await expect(PartsInventoryApi.search('castle')).rejects.toThrow('Unavailable');
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, json: async () => { throw new Error(); } } as Response);
  await expect(PartsInventoryApi.select('123-1')).rejects.toThrow('Could not load');
});
it('carries the finite inventory alongside image and text prompts to Nova', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ generation_id: 'new' }));
  await NovaToBricksApiService.generate({ ...DEFAULT_NOVA_OPTIONS, prompt: 'A car', imageBase64: 'image', partsInventory: inventory }, 'owner');
  const body = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]?.body as string);
  expect(body.parts_inventory).toEqual(inventory);
  expect(body.prompt).toBe('A car'); expect(body.image_base64).toBe('image');
});
