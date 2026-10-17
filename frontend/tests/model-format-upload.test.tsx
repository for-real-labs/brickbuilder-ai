import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { ModelFormatUploadCard } from '../src/components/ModelFormatUploadCard';
import * as conversion from '../src/services/modelFormatConversion';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
function button(label: string) { return Array.from(host.querySelectorAll('button')).find(node => node.textContent === label)!; }
function mount(format: 'obj' | 'glb') {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<ModelFormatUploadCard inputFormat={format} />));
}
async function select(file: File) {
  await act(async () => {
    const picker = host.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
    picker.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:download') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); });

it.each(['obj', 'glb'] as const)('converts %s, downloads with analytics, and releases the output URL', async inputFormat => {
  const outputFormat = inputFormat === 'obj' ? 'glb' : 'obj';
  const convert = vi.spyOn(conversion, 'convertModelFormat').mockResolvedValue({ blob: new Blob(['converted']), filename: `model.${outputFormat}`, vertices: 3, triangles: 1 });
  mount(inputFormat);
  expect(host.firstElementChild?.classList.contains('ph-no-capture')).toBe(true);
  act(() => button(`Choose ${inputFormat.toUpperCase()} file`).click());
  expect(posthog.capture).toHaveBeenCalledWith('model_format_upload_picker_opened', expect.objectContaining({ input_format: inputFormat }));
  const file = new File(['mesh'], `model.${inputFormat}`);
  await select(file);
  await act(async () => button(`Convert to ${outputFormat.toUpperCase()}`).click());
  expect(convert).toHaveBeenCalledWith(file, inputFormat);
  const download = host.querySelector<HTMLAnchorElement>('a[download]')!;
  expect(download.download).toBe(`model.${outputFormat}`);
  expect(download.href).toBe('blob:download');
  // Prevent jsdom navigation while exercising the actual handler.
  download.addEventListener('click', event => event.preventDefault());
  act(() => download.click());
  expect(posthog.capture).toHaveBeenCalledWith('model_format_download_clicked', expect.objectContaining({ input_format: inputFormat, output_format: outputFormat }));
  await select(new File(['other'], `other.${inputFormat}`));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:download');
  expect(host.querySelector('a[download]')).toBeNull();
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('model.obj');
});

it('rejects unsupported files and clears an earlier selection', async () => {
  const convert = vi.spyOn(conversion, 'convertModelFormat');
  mount('obj');
  await select(new File(['mesh'], 'valid.obj'));
  await select(new File(['mesh'], 'invalid.glb'));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('.obj file');
  expect(button('Convert to GLB')).toBeUndefined();
  await select(new File([], 'empty.obj'));
  expect(host.querySelector('[role=alert]')?.textContent).toContain('nonempty');
  expect(convert).not.toHaveBeenCalled();
});

it('prevents duplicate conversions and recovers after a conversion error', async () => {
  let fail!: (error: Error) => void;
  const convert = vi.spyOn(conversion, 'convertModelFormat').mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
  mount('glb');
  await select(new File(['mesh'], 'model.glb'));
  await act(async () => button('Convert to OBJ').click());
  expect(button('Converting…').disabled).toBe(true);
  expect(button('Change file').disabled).toBe(true);
  act(() => button('Converting…').click());
  expect(convert).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error('Invalid GLB')));
  expect(host.querySelector('[role=alert]')?.textContent).toBe('Invalid GLB');
  expect(button('Convert to OBJ').disabled).toBe(false);
});
