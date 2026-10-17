import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiFetch';
import { convertMeshToVoxels } from '../src/services/meshToVoxelsApi';
vi.mock('../src/services/apiFetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('posts a multipart mesh with credentials and returns the download', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, blob: async () => new Blob(['VOX ']) } as Response);
  const file = new File(['mesh'], 'model.obj');
  expect((await convertMeshToVoxels(file, 'obj', 'vox', 32, 'owner')).size).toBe(4);
  const [url, options] = vi.mocked(apiFetch).mock.calls[0];
  expect(url).toMatch(/\/meshToVoxels$/);
  expect(options?.headers).toEqual({ Authorization: 'Bearer owner' });
  const form = options?.body as FormData;
  expect(form.get('file')).toBe(file);
  expect(form.get('input_format')).toBe('obj');
  expect(form.get('output_format')).toBe('vox');
  expect(form.get('resolution')).toBe('32');
});

it('supports guests and surfaces safe backend errors', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, json: async () => ({ detail: 'Converters are busy' }) } as Response);
  await expect(convertMeshToVoxels(new File(['mesh'], 'mesh.glb'), 'glb', 'qb', 40)).rejects.toThrow('Converters are busy');
  expect(vi.mocked(apiFetch).mock.calls[0][1]?.headers).toEqual({});
});

it('rejects empty successful responses and handles non-JSON proxy failures', async () => {
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: true, blob: async () => new Blob([]) } as Response);
  await expect(convertMeshToVoxels(new File(['mesh'], 'mesh.glb'), 'glb', 'vox', 40)).rejects.toThrow('empty file');
  vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, json: async () => { throw new Error('proxy'); } } as unknown as Response);
  await expect(convertMeshToVoxels(new File(['mesh'], 'mesh.glb'), 'glb', 'vox', 40)).rejects.toThrow('Conversion failed');
});
