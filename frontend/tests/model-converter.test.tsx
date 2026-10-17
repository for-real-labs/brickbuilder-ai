import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { GlbUploadCard } from '../src/components/GlbUploadCard';
import { GlbToBricksApiService } from '../src/services/glbToBricksApi';
import { NovaToBricksApiService } from '../src/services/novaToBricksApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router-dom', async importActual => ({ ...(await importActual<object>()), useNavigate: () => navigate }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'owner-token' } }) }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
function button(text: string) {
  return Array.from(host.querySelectorAll('button')).find(button => button.textContent?.trim() === text)!;
}
function mount(format: 'glb' | 'obj') {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<MemoryRouter initialEntries={[`/${format}-to-lego`]}><GlbUploadCard format={format} /></MemoryRouter>));
}
async function select(name: string, contents = 'mesh') {
  const input = host.querySelector('input[type=file]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([contents], name)] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:model') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.spyOn(console, 'error').mockImplementation(() => {}); // jsdom has no WebGL renderer.
  vi.spyOn(GlbToBricksApiService, 'uploadGlb').mockResolvedValue({ generation_id: 'voxel-id', message: 'started' });
  vi.spyOn(GetGenerationApiService, 'pollUntilComplete').mockResolvedValue({ status: 'completed', generation_id: 'voxel-id' } as never);
  vi.spyOn(NovaToBricksApiService, 'edit').mockResolvedValue({ generation_id: 'all-parts-id', message: 'started' });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });

it.each(['glb', 'obj'] as const)('converts %s in voxel mode with the selected size and owner credentials', async format => {
  mount(format);
  expect(host.querySelector('input[type=file]')?.getAttribute('accept')).toBe(`.${format}`);
  act(() => button(`Choose ${format.toUpperCase()} file`).click());
  expect(posthog.capture).toHaveBeenCalledWith(`${format}_upload_picker_opened`, expect.objectContaining({ input_type: format }));
  await select(`castle.${format}`);
  const slider = host.querySelector<HTMLInputElement>('input[type=range]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '25');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('Convert to bricks').click());
  expect(GlbToBricksApiService.uploadGlb).toHaveBeenCalledWith(expect.any(File), 'trimesh', 25, 'owner-token', format);
  expect(NovaToBricksApiService.edit).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledWith('/?id=voxel-id');
});

it.each(['glb', 'obj'] as const)('voxelizes %s before passing its model to the same all-parts editor as the landing page', async format => {
  mount(format);
  act(() => button('All LEGO parts').click());
  expect(button('From image')).toBeTruthy();
  expect(button(`From ${format.toUpperCase()}`).getAttribute('aria-pressed')).toBe('true');
  await select(`castle.${format}`);
  let finish!: (result: never) => void;
  vi.mocked(GetGenerationApiService.pollUntilComplete).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button('Convert to bricks').click());
  expect(NovaToBricksApiService.edit).not.toHaveBeenCalled();
  expect(button('All LEGO parts').disabled).toBe(true);
  await act(async () => finish({ generation_id: 'voxel-id', status: 'completed' } as never));
  expect(NovaToBricksApiService.edit).toHaveBeenCalledWith('voxel-id', expect.stringContaining('full LEGO parts catalog'), 'owner-token');
  expect(navigate).toHaveBeenCalledWith('/?id=all-parts-id');
  expect(posthog.capture).toHaveBeenCalledWith('generation_started', expect.objectContaining({ mode: 'all_parts', input_type: format, source_generation_id: 'voxel-id' }));
});

it('opens the existing image workflow with all parts selected', () => {
  mount('obj');
  act(() => button('All LEGO parts').click());
  act(() => button('From image').click());
  expect(button('Choose OBJ file')).toBeUndefined();
  act(() => button('Continue with image').click());
  expect(navigate).toHaveBeenCalledWith('/image-to-lego?mode=all_parts');
  expect(GlbToBricksApiService.uploadGlb).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('model_converter_source_selected', expect.objectContaining({ source: 'image' }));
});

it('keeps the voxel version accessible when the all-parts editor fails', async () => {
  mount('glb');
  act(() => button('All LEGO parts').click());
  await select('castle.glb');
  vi.mocked(NovaToBricksApiService.edit).mockRejectedValueOnce(new Error('Builder is unavailable'));
  await act(async () => button('Convert to bricks').click());
  expect(host.textContent).toContain('Builder is unavailable');
  act(() => button('Open voxel version').click());
  expect(navigate).toHaveBeenCalledWith('/?id=voxel-id');
});

it('rejects incorrect extensions and empty uploads before conversion', async () => {
  mount('obj');
  await select('castle.glb');
  expect(host.textContent).toContain('Please select a .obj file');
  await select('castle.obj', '');
  expect(host.textContent).toContain('Choose a nonempty model file up to 50 MB');
  expect(GlbToBricksApiService.uploadGlb).not.toHaveBeenCalled();
});
