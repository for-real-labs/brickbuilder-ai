import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LDrawUploadSection } from '../src/components/LDrawUploadSection';
import { UploadLdrawApiService } from '../src/services/uploadLdrawApi';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each(['io', 'ldr', 'mpd'])('uploads a selected .%s file and opens the saved model', async extension => {
  const upload = vi.spyOn(UploadLdrawApiService, 'upload').mockResolvedValue({ generation_id: 'model-id' });
  const open = vi.fn();
  act(() => root.render(<LDrawUploadSection authToken="token" onImported={open} />));
  const input = container.querySelector('input')!;
  expect(input.accept).toBe('.io,.ldr,.mpd');
  const file = new File(['model'], `castle.${extension}`);
  await act(async () => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(upload).toHaveBeenCalledWith(file, 'token', expect.any(AbortSignal));
  expect(open).toHaveBeenCalledWith('model-id');
});

it('accepts dropped files without invoking the landing image uploader', async () => {
  const upload = vi.spyOn(UploadLdrawApiService, 'upload').mockResolvedValue({ generation_id: 'dropped' });
  const open = vi.fn(); const outerDrop = vi.fn();
  act(() => root.render(<div onDrop={outerDrop}><LDrawUploadSection onImported={open} /></div>));
  const file = new File(['model'], 'castle.mpd');
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
  await act(async () => container.querySelector('section')!.dispatchEvent(drop));
  expect(upload).toHaveBeenCalledWith(file, undefined, expect.any(AbortSignal));
  expect(open).toHaveBeenCalledWith('dropped');
  expect(outerDrop).not.toHaveBeenCalled();
});

it('displays import errors and lets the user retry', async () => {
  vi.spyOn(UploadLdrawApiService, 'upload').mockRejectedValue(new Error('Invalid Studio file'));
  const open = vi.fn();
  act(() => root.render(<LDrawUploadSection onImported={open} />));
  const input = container.querySelector('input')!;
  await act(async () => { Object.defineProperty(input, 'files', { value: [new File(['bad'], 'bad.io')] }); input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Invalid Studio file');
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it('sends the file as multipart data with ownership credentials', async () => {
  const fetch = vi.spyOn(window, 'fetch').mockResolvedValue(new Response(JSON.stringify({ generation_id: 'g' })));
  const file = new File(['model'], 'castle.mpd');
  await expect(UploadLdrawApiService.upload(file, 'token')).resolves.toEqual({ generation_id: 'g' });
  const [url, options] = fetch.mock.calls[0];
  expect(url).toContain('/uploadLdraw');
  expect((options?.body as FormData).get('file')).toBe(file);
  expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer token');
  expect(new Headers(options?.headers).get('X-Guest-Session')).toMatch(/^[a-f0-9]{64}$/);
  expect(new Headers(options?.headers).has('Content-Type')).toBe(false);
});

it('rejects unsupported or oversized files before upload', async () => {
  const fetch = vi.spyOn(window, 'fetch');
  await expect(UploadLdrawApiService.upload(new File(['bad'], 'bad.exe'))).rejects.toThrow('Choose');
  const file = new File(['model'], 'big.ldr'); Object.defineProperty(file, 'size', { value: 17 * 1024 * 1024 });
  await expect(UploadLdrawApiService.upload(file)).rejects.toThrow('16 MB');
  expect(fetch).not.toHaveBeenCalled();
});
