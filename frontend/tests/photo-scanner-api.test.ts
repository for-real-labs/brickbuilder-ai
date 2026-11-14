import { expect, it, vi } from 'vitest';
import { authenticatedApiFetch } from '../src/services/apiFetch';
import { PhotoScannerApi, canUsePhotoScanner, scanFinished, type PhotoScan } from '../src/services/photoScannerApi';
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: vi.fn() }));
it('uses authenticated transport for every operation including images', async () => {
 const fetch = vi.mocked(authenticatedApiFetch);
 fetch.mockImplementation(async () => new Response(JSON.stringify({ id: 'scan' }), { status: 200 }));
 await PhotoScannerApi.access(); await PhotoScannerApi.start(new File(['image'], 'photo.jpg')); await PhotoScannerApi.get('scan'); await PhotoScannerApi.cancel('scan'); await PhotoScannerApi.review('scan', '1', { excluded: true });
 expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/photo-scanner/access', '/photo-scanner/scans', '/photo-scanner/scans/scan', '/photo-scanner/scans/scan/cancel', '/photo-scanner/scans/scan/regions/1']);
 expect(fetch.mock.calls[1][1]?.body).toBeInstanceOf(FormData); expect(fetch.mock.calls[4][1]?.method).toBe('PATCH');
 URL.createObjectURL = vi.fn(() => 'blob:private'); await expect(PhotoScannerApi.asset('scan', 'photo', new AbortController().signal)).resolves.toBe('blob:private');
 expect(fetch.mock.calls.at(-1)?.[0]).toContain('/scans/scan/assets/photo');
});
it('surfaces authorization and expired-scan errors and rejects inaccessible images', async () => {
 vi.mocked(authenticatedApiFetch).mockResolvedValue(new Response(JSON.stringify({ detail: 'This prototype is private.' }), { status: 403 }));
 await expect(PhotoScannerApi.access()).rejects.toThrow('This prototype is private.');
 vi.mocked(authenticatedApiFetch).mockResolvedValue(new Response('not JSON', { status: 500 })); await expect(PhotoScannerApi.get('scan')).rejects.toThrow('unavailable');
 await expect(PhotoScannerApi.asset('scan', 'photo', new AbortController().signal)).rejects.toThrow('Image unavailable');
});
it('recognizes the private account and terminal scan states', () => {
 expect(canUsePhotoScanner('JAKE@BRICKBUILDER.AI')).toBe(true); expect(canUsePhotoScanner(null)).toBeFalsy(); expect(canUsePhotoScanner('jake@example.com')).toBe(false);
 for (const status of ['complete', 'cancelled', 'failed']) expect(scanFinished({ status } as PhotoScan)).toBe(true);
 expect(scanFinished({ status: 'identifying' } as PhotoScan)).toBe(false);
});
