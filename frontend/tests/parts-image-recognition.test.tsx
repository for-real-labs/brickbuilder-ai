import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { PartsImageRecognition } from '../src/components/PartsImageRecognition';
import { recognizeParts } from '../src/services/brickognizeApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/brickognizeApi', () => ({ recognizeParts: vi.fn() }));
const matches = [
  { id: '3001', name: 'Brick 2 x 4', imageUrl: 'https://storage.googleapis.com/brickognize-static/3001.webp', score: 0.95 },
  { id: '3002', name: 'Brick 2 x 3', imageUrl: null, score: 0.6 },
];
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
afterEach(() => { act(() => root.unmount()); element.remove(); vi.clearAllMocks(); });
const render = (disabled = false, onDrop = vi.fn()) => act(() => root.render(<div onDrop={onDrop}><PartsImageRecognition disabled={disabled} /></div>));
const upload = async () => {
  const input = element.querySelector('input')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['photo'], 'brick.jpg', { type: 'image/jpeg' })] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
};

it('opens the image picker and reports all matches in an expandable thumbnail grid', async () => {
  vi.mocked(recognizeParts).mockResolvedValue(matches); render();
  const click = vi.spyOn(element.querySelector('input')!, 'click');
  act(() => element.querySelector('button')!.click()); expect(click).toHaveBeenCalled();
  await upload();
  expect(element.querySelector('[role=status]')?.textContent).toContain('2 possible matches');
  const details = element.querySelector('details')!;
  expect(details.open).toBe(false);
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(details.open).toBe(true);
  expect(element.querySelectorAll('li')).toHaveLength(2);
  expect(details.textContent).toContain('Part 3001'); expect(details.textContent).toContain('95% match');
  expect(element.querySelector('img')?.alt).toBe('Brick 2 x 4');
  expect(posthog.capture).toHaveBeenCalledWith('existing_parts_image_results_toggled', { expanded: true, match_count: 2 });
  expect(element.textContent).toContain('not added to your build inventory');
});

it('handles no matches and service errors and allows retrying the same file', async () => {
  vi.mocked(recognizeParts).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Please try again.')).mockResolvedValueOnce(matches);
  render(); await upload(); expect(element.textContent).toContain('No matching parts found');
  await upload(); expect(element.querySelector('[role=alert]')?.textContent).toBe('Please try again.');
  await upload(); expect(element.querySelector('[role=alert]')).toBeNull();
  expect(element.querySelector('input')!.value).toBe('');
});

it('prevents duplicate uploads, shows progress, and aborts when unmounted', async () => {
  vi.mocked(recognizeParts).mockImplementation(() => new Promise(() => {}));
  render(); await upload(); await upload();
  expect(recognizeParts).toHaveBeenCalledTimes(1);
  expect(element.querySelector('button')!.disabled).toBe(true);
  expect(element.textContent).toContain('Identifying…');
  const signal = vi.mocked(recognizeParts).mock.calls[0][1];
  act(() => root.render(null)); expect(signal.aborted).toBe(true);
});

it('stops photo drops from reaching the parts-list uploader and respects disabled state', async () => {
  vi.mocked(recognizeParts).mockResolvedValue(matches);
  const parentDrop = vi.fn(); render(true, parentDrop);
  const drop = () => {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['photo'], 'brick.jpg')] } });
    element.querySelector('section')!.dispatchEvent(event);
  };
  await act(async () => drop()); expect(recognizeParts).not.toHaveBeenCalled();
  render(false, parentDrop); await act(async () => drop());
  expect(recognizeParts).toHaveBeenCalledTimes(1); expect(parentDrop).not.toHaveBeenCalled();
});
