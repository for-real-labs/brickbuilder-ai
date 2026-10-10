import { describe, expect, it, vi } from 'vitest';
import { prepareImageUpload } from '../src/utils/prepareImageUpload';

vi.mock('heic-to/csp', () => ({ heicTo: vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' })) }));

vi.mock('utif', () => ({ default: { decode: vi.fn(() => [{ t256: [1], t257: [1], width: 1, height: 1 }]), decodeImage: vi.fn(), toRGBA8: vi.fn(() => new Uint8Array(4)) } }));

describe('image preparation', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])('keeps provider-supported %s images', async type => {
    const file = new File(['image'], 'image', { type });
    expect(await prepareImageUpload(file)).toBe(file);
  });
  it.each([
    { file: new File([], 'empty.png', { type: 'image/png' }), message: 'empty' },
    { file: new File(['text'], 'notes.txt', { type: 'text/plain' }), message: 'image file' },
  ])('rejects invalid uploads: $message', async ({ file, message }) => {
    await expect(prepareImageUpload(file)).rejects.toThrow(message);
  });
  it('rejects oversized images before decoding', async () => {
    const file = new File(['image'], 'big.heic');
    Object.defineProperty(file, 'size', { value: 51 * 1024 * 1024 });
    await expect(prepareImageUpload(file)).rejects.toThrow('50 MB');
  });
  it('decodes TIFF into a provider-safe JPEG', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
    vi.stubGlobal('ImageData', class {});
    const file = new File(['tiff'], 'photo.tiff', { type: 'image/tiff' });
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(1) });
    try {
      const result = await prepareImageUpload(file);
      expect(result.type).toBe('image/jpeg');
      expect(result.name).toBe('photo.jpg');
      expect((await import('utif')).default.decodeImage).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it.each(['photo.HEIC', 'photo.heif'])('converts %s with a missing MIME type to provider-safe JPEG and releases the preview URL', async name => {
    const revoke = vi.fn();
    const BrowserURL = URL;
    vi.stubGlobal('URL', class extends BrowserURL { static createObjectURL = vi.fn(() => 'blob:converted'); static revokeObjectURL = revoke; });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as any);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['jpeg'], { type: 'image/jpeg' })));
    vi.stubGlobal('Image', class { naturalWidth = 4000; naturalHeight = 3000; decode = async () => {}; });
    try {
      const result = await prepareImageUpload(new File(['heic'], name));
      expect(result.name).toBe('photo.jpg');
      expect(result.type).toBe('image/jpeg');
      expect((await import('heic-to/csp')).heicTo).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/jpeg' }));
      expect(revoke).toHaveBeenCalledWith('blob:converted');
    } finally { vi.unstubAllGlobals(); }
  });
});
