import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { VoxelUploadCard } from '../src/components/VoxelUploadCard';
import { LegoDesignCallout } from '../src/components/LegoDesignCallout';
import { convertMeshToVoxels } from '../src/services/meshToVoxelsApi';
import { VOXEL_CONVERTERS, VOXEL_FORMATS } from '../src/voxelConverters';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'owner-token' } }) }));
vi.mock('../src/components/ModelMeshPreview', () => ({ ModelMeshPreview: () => <div>Mesh preview</div> }));
vi.mock('../src/services/meshToVoxelsApi', () => ({ convertMeshToVoxels: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)!;
function mount(input: 'glb' | 'obj', output: keyof typeof VOXEL_FORMATS) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<MemoryRouter initialEntries={[`/${input}-to-${output}`]}><VoxelUploadCard input={input} output={output} /><LegoDesignCallout page={`/${input}-to-${output}`} /></MemoryRouter>));
}
async function select(name: string, data = 'mesh') {
  const input = host.querySelector('input[type=file]')!;
  await act(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([data], name)] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn().mockReturnValueOnce('blob:preview').mockReturnValue('blob:download') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  vi.mocked(convertMeshToVoxels).mockResolvedValue(new Blob(['voxels']));
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });

it.each(VOXEL_CONVERTERS)('downloads the selected voxel format at $path', async ({ input, output, path }) => {
  mount(input, output);
  const label = VOXEL_FORMATS[output].name;
  expect(button(`Convert to ${label}`).disabled).toBe(true);
  act(() => button(`Choose ${input.toUpperCase()} file`).click());
  expect(posthog.capture).toHaveBeenCalledWith('voxel_converter_picker_opened', expect.objectContaining({ page: path, output_format: output }));
  await select(`castle.${input}`);
  await act(async () => button(`Convert to ${label}`).click());
  expect(convertMeshToVoxels).toHaveBeenCalledWith(expect.any(File), input, output, 40, 'owner-token');
  const download = host.querySelector<HTMLAnchorElement>('a[download]')!;
  expect(download.download).toBe(`castle.${output}`);
  expect(download.getAttribute('href')).toBe('blob:download');
  download.addEventListener('click', event => event.preventDefault());
  act(() => download.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(posthog.capture).toHaveBeenCalledWith('voxel_converter_downloaded', expect.objectContaining({ page: path, output_format: output, resolution: 40 }));
  if (output === 'binvox') expect(host.textContent).toContain('BINVOX stores occupied cells only');
  act(() => root.unmount());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download');
});

it('rejects invalid files and clears a previous result', async () => {
  mount('obj', 'vox');
  await select('castle.obj');
  await act(async () => button('Convert to VOX').click());
  await select('wrong.glb');
  expect(host.querySelector('a[download]')).toBeNull();
  expect(host.textContent).toContain('Please select a .obj file');
  expect(button('Convert to VOX').disabled).toBe(true);
  await select('empty.obj', '');
  expect(host.textContent).toContain('Choose a nonempty model file up to 50 MB');
  expect(convertMeshToVoxels).toHaveBeenCalledTimes(1);
});

it('locks controls while converting and shows a retryable backend error', async () => {
  mount('glb', 'qb'); await select('castle.glb');
  let fail!: (error: Error) => void;
  vi.mocked(convertMeshToVoxels).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await act(async () => button('Convert to QB').click());
  expect(button('Converting…').disabled).toBe(true);
  expect(button('Choose GLB file').disabled).toBe(true);
  await act(async () => fail(new Error('Try a simpler mesh')));
  expect(host.querySelector('[role=alert]')?.textContent).toBe('Try a simpler mesh');
  expect(button('Convert to QB').disabled).toBe(false);
  expect(host.querySelector('a[download]')).toBeNull();
});

it('links and tracks all three LEGO design sources', () => {
  mount('glb', 'vox');
  const callout = host.querySelector('aside')!;
  for (const destination of ['/glb-to-lego', '/image-to-lego', '/#landing-build-prompt']) {
    const link = callout.querySelector<HTMLAnchorElement>(`a[href="${destination}"]`)!;
    expect(link).not.toBeNull();
    act(() => link.click());
    expect(posthog.capture).toHaveBeenCalledWith('converter_lego_design_clicked', { page: '/glb-to-vox', destination });
  }
});
