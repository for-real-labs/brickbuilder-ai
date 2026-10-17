import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { ImageModelUploadCard } from '../src/components/ImageModelUploadCard';
import { startImageModel, waitForImageModel, downloadImageModel } from '../src/services/imageToModel';
import { convertModelFormat } from '../src/services/modelFormatConversion';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'owner-token' } }) }));
vi.mock('../src/components/ModelMeshPreview', () => ({ ModelMeshPreview: () => <div>3D preview</div> }));
vi.mock('../src/services/imageToModel', () => ({ startImageModel: vi.fn(), waitForImageModel: vi.fn(), downloadImageModel: vi.fn() }));
vi.mock('../src/services/modelFormatConversion', () => ({ convertModelFormat: vi.fn() }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
const button = (name: string) => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === name)!;
function mount(output: '3d' | 'glb' | 'obj' = '3d') {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<MemoryRouter><ImageModelUploadCard output={output} /></MemoryRouter>));
}
async function select(file = new File(['image'], 'photo.png', { type: 'image/png' })) {
  await act(async () => {
    const input = host.querySelector('input[type=file]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:model') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.mocked(startImageModel).mockResolvedValue('generation-id');
  vi.mocked(waitForImageModel).mockResolvedValue('https://storage.example/model.glb');
  vi.mocked(downloadImageModel).mockResolvedValue(new File(['glb'], 'image-model.glb'));
  vi.mocked(convertModelFormat).mockResolvedValue({ blob: new Blob(['v 0 0 0']), filename: 'model.obj', triangles: 1, vertices: 3 });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); });

it.each(['3d', 'glb', 'obj'] as const)('generates from /image-to-%s using the current backend and offers both formats', async output => {
  mount(output);
  act(() => button('Choose image').click());
  expect(posthog.capture).toHaveBeenCalledWith('image_model_upload_picker_opened', expect.objectContaining({ page: `/image-to-${output}` }));
  await select();
  await act(async () => button('Generate 3D model').click());
  expect(startImageModel).toHaveBeenCalledWith(expect.any(File), 'owner-token');
  expect(waitForImageModel).toHaveBeenCalledWith('generation-id', expect.any(AbortSignal), expect.any(Function));
  expect(host.textContent).toContain('3D preview');
  expect(host.querySelector('a[download="image-model.glb"]')).not.toBeNull();
  await act(async () => button('Export OBJ').click());
  expect(convertModelFormat).toHaveBeenCalledWith(expect.any(File), 'glb');
  const obj = host.querySelector<HTMLAnchorElement>('a[download="image-model.obj"]')!;
  expect(obj).not.toBeNull();
  act(() => obj.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(posthog.capture).toHaveBeenCalledWith('image_model_download_clicked', expect.objectContaining({ download_format: 'obj' }));
  expect(startImageModel).toHaveBeenCalledTimes(1);
  expect(host.querySelector('a[href="/?id=generation-id"]')).not.toBeNull();
});

it('retries polling or storage failures without starting another credit-consuming generation', async () => {
  mount(); await select();
  vi.mocked(downloadImageModel).mockRejectedValueOnce(new Error('Storage unavailable'));
  await act(async () => button('Generate 3D model').click());
  expect(host.querySelector('[role=alert]')?.textContent).toBe('Storage unavailable');
  await act(async () => button('Load existing result').click());
  expect(startImageModel).toHaveBeenCalledTimes(1);
  expect(waitForImageModel).toHaveBeenCalledTimes(2);
  expect(host.querySelector('a[download="image-model.glb"]')).not.toBeNull();
});

it('keeps GLB available when OBJ export fails and clears results when choosing another image', async () => {
  mount('obj'); await select();
  await act(async () => button('Generate 3D model').click());
  vi.mocked(convertModelFormat).mockRejectedValueOnce(new Error('Unsupported mesh'));
  await act(async () => button('Export OBJ').click());
  expect(host.querySelector('[role=alert]')?.textContent).toBe('Unsupported mesh');
  expect(host.querySelector('a[download="image-model.glb"]')).not.toBeNull();
  await select(new File(['next'], 'next.jpg', { type: 'image/jpeg' }));
  expect(host.querySelector('a[download]')).toBeNull();
  expect(button('Generate 3D model')).toBeDefined();
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

it('rejects empty or unsupported files before contacting the backend', async () => {
  mount();
  await select(new File([], 'empty.png', { type: 'image/png' }));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('empty');
  await select(new File(['text'], 'notes.txt', { type: 'text/plain' }));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('choose an image');
  expect(startImageModel).not.toHaveBeenCalled();
});

it('aborts result polling when leaving the page', async () => {
  mount(); await select();
  vi.mocked(waitForImageModel).mockImplementationOnce(async (_id, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  await act(async () => button('Generate 3D model').click());
  const signal = vi.mocked(waitForImageModel).mock.calls[0][1];
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
});
