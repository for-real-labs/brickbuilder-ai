import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PhotoScannerPage from '../src/pages/PhotoScannerPage';
import { groupScanRegions, PhotoScannerApi, type ScanRegion, type PhotoScan } from '../src/services/photoScannerApi';
const auth = vi.hoisted(() => ({ user: null as null | { id: string; email: string }, loading: false, isSupabaseConfigured: true, signOut: vi.fn() }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const match = { id: '3001', name: 'Brick 2 x 4', score: .92, image_url: null };
const region = (id: string, changes = {}): ScanRegion => ({ id, box: [0, 0, 30, 30], match, candidates: [match, { ...match, id: '3002' }], status: 'identified', excluded: false, reviewed: false, ...changes });
const snapshot: PhotoScan = { id: 'test', width: 100, height: 100, status: 'complete', regions: [region('1'), region('2'), region('3', { match: null, status: 'failed' })], completed: 3, tiles_done: 1, tiles_total: 1, warnings: [], elapsed_seconds: 12, duplicates_removed: 0, retries: 0 };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { auth.user = null; auth.isSupabaseConfigured = true; sessionStorage.clear(); host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.spyOn(PhotoScannerApi, 'asset').mockResolvedValue('blob:photo'); URL.revokeObjectURL = vi.fn(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const mount = async () => act(async () => { root.render(<HelmetProvider><MemoryRouter><PhotoScannerPage /></MemoryRouter></HelmetProvider>); });
function allow(status = 'complete') { auth.user = { id: 'jake', email: 'jake@brickbuilder.ai' }; sessionStorage.setItem('photo-scanner:jake', 'test'); vi.spyOn(PhotoScannerApi, 'access').mockResolvedValue({ allowed: true }); vi.spyOn(PhotoScannerApi, 'get').mockResolvedValue({ ...snapshot, status }); }
it('groups one selected identity per region, excluding false detections and unmatched', () => {
 const groups = groupScanRegions([region('1'), region('2'), region('3', { excluded: true }), region('4', { match: null })]);
 expect(groups).toHaveLength(1); expect(groups[0].regions.map(r => r.id)).toEqual(['1', '2']);
});
it.each([null, { id: 'other', email: 'other@example.com' }])('blocks page and API calls for %j', async user => {
 auth.user = user; const access = vi.spyOn(PhotoScannerApi, 'access'); await mount(); expect(host.textContent).toContain('Private prototype'); expect(host.querySelector('input[type=file]')).toBeNull(); expect(access).not.toHaveBeenCalled();
});
it('requires server approval before exposing upload', async () => {
 auth.user = { id: 'jake', email: 'jake@brickbuilder.ai' }; vi.spyOn(PhotoScannerApi, 'access').mockRejectedValue(new Error('This prototype is private.')); await mount(); expect(host.textContent).toContain('This prototype is private.'); expect(host.querySelector('input[type=file]')).toBeNull();
});
it('restores partial results, reviews and excludes a false detection', async () => {
 allow(); const save = vi.spyOn(PhotoScannerApi, 'review').mockResolvedValue({ ...snapshot, regions: [region('1', { excluded: true }), region('2'), snapshot.regions[2]] }); await mount(); expect(host.textContent).toContain('×2'); expect(host.textContent).toContain('failed');
 await act(async () => { (host.querySelector('.scanner-region-links button') as HTMLButtonElement).click(); });
 await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Exclude detection')!.click()); expect(save).toHaveBeenCalledWith('test', '1', { excluded: true }); expect(host.textContent).toContain('×1');
});
it('cancels and retains partial results', async () => {
 allow('identifying'); const cancel = vi.spyOn(PhotoScannerApi, 'cancel').mockResolvedValue({ ...snapshot, status: 'cancelled' }); await mount(); await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Cancel scan')!.click()); expect(cancel).toHaveBeenCalledWith('test'); expect(host.textContent).toContain('partial results saved'); expect(host.textContent).toContain('×2');
});
it('removes private results on account switch', async () => {
 allow(); await mount(); auth.user = { id: 'other', email: 'other@example.com' }; await mount(); expect(host.textContent).not.toContain('Brick 2 x 4'); expect(host.querySelector('img')).toBeNull();
});

it('keeps the scanner destination through sign-in', async () => {
 await mount(); expect(host.querySelector('a[href="/login?next=%2Fphoto-scanner"]')).not.toBeNull();
 expect(host.textContent).toContain('jake@brickbuilder.ai');
});
it('explains local anonymous mode and links to the live scanner', async () => {
 auth.isSupabaseConfigured = false; await mount();
 expect(host.textContent).toContain('local workspace is not signed in');
 expect(host.querySelector('a[href="https://brickbuilder.ai/photo-scanner"]')).not.toBeNull();
});
it('identifies the wrong account without running a scan', async () => {
 auth.user = { id: 'other', email: 'other@example.com' }; const access = vi.spyOn(PhotoScannerApi, 'access'); await mount();
 expect(host.textContent).toContain('other@example.com'); expect(host.textContent).toContain('Switch account'); expect(access).not.toHaveBeenCalled();
});
