import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import posthog from 'posthog-js';
import { InstructionsPostcard, getPostcardTheme } from '../src/components/checkout/InstructionsPostcard';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const viewer = vi.hoisted(() => ({ props: [] as any[], captureCurrentViewPng: vi.fn(() => 'data:image/png;base64,adjusted-view') }));
vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: (props: any) => {
  viewer.props.push(props);
  React.useEffect(() => {
    expect(document.querySelector('dialog')!.open).toBe(true);
    props.onExportCaptureReady({ captureCurrentViewPng: viewer.captureCurrentViewPng });
    return () => props.onExportCaptureReady(null);
  }, [props.onExportCaptureReady]);
  return <div data-testid="postcard-viewer"><button type="button" onClick={() => {
    props.onCameraChange({ position: { x: 80, y: 20, z: 40 }, target: { x: 1, y: 2, z: 3 } });
    props.onViewInteractionEnd();
  }}>Rotate model</button></div>;
} }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const props = { selected: false, disabled: false, onChange: vi.fn(), modelName: 'Galaxy Explorer', modelImage: 'https://example.com/model.png', generationId: 'g/123' };
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: function () { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value: function () { this.open = false; this.dispatchEvent(new Event('close')); } });
  props.onChange.mockReset(); viewer.props = []; viewer.captureCurrentViewPng.mockClear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = (overrides = {}) => act(() => root.render(<InstructionsPostcard {...props} {...overrides} />));
const open = () => act(() => container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.click());

it('opens a model-themed postcard with its actual image and requested explanation', () => {
  render(); open();
  expect(container.querySelector('dialog')!.open).toBe(true);
  expect(container.textContent).toContain('Select this option to ship a post card with a QR code link to the instructions.');
  expect(container.querySelector('.checkout-postcard-space')).not.toBeNull();
  expect(container.querySelector('h3')?.textContent).toBe('Galaxy Explorer');
  expect(container.querySelector('img')?.getAttribute('src')).toBe(props.modelImage);
  expect(container.querySelector('img')?.alt).toContain('Galaxy Explorer');
  expect(props.onChange).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('order_instructions_postcard_preview_opened', { generation_id: props.generationId });
});

it('renders a QR code that independently decodes to the selected model’s instructions', () => {
  render(); open();
  const svg = container.querySelector('svg[role="img"]')!;
  const size = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
  const scale = 8, width = size * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  const path = svg.querySelector('path')!.getAttribute('d')!;
  for (const [, x, y] of path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
    for (let row = Number(y) * scale; row < (Number(y) + 1) * scale; row++) {
      for (let col = Number(x) * scale; col < (Number(x) + 1) * scale; col++) {
        const i = (row * width + col) * 4;
        pixels[i] = 23; pixels[i + 1] = 32; pixels[i + 2] = 42;
      }
    }
  }
  const url = 'https://brickbuilder.ai/instructions?id=g%2F123';
  expect(jsQR(pixels, width, width)?.data).toBe(url);
  expect(container.querySelector('a.checkout-postcard-qr')?.getAttribute('href')).toBe(url);
});

it('tracks opting in without leaking the model name or image, and disables changes during payment', () => {
  render();
  act(() => container.querySelector<HTMLInputElement>('input')!.click());
  expect(props.onChange).toHaveBeenCalledWith(true);
  expect(posthog.capture).toHaveBeenCalledWith('order_instructions_postcard_changed', { generation_id: props.generationId, selected: true });
  render({ selected: true, disabled: true });
  const checkbox = container.querySelector<HTMLInputElement>('input')!;
  expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!.disabled).toBe(true);
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain(props.modelName);
  expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain(props.modelImage);
});

it('closes with its button or Escape and restores focus and scrolling', () => {
  render(); open();
  expect(document.body.style.overflow).toBe('hidden');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close postcard preview"]')!.click());
  expect(container.querySelector('dialog')!.open).toBe(false);
  expect(document.activeElement).toBe(container.querySelector('[aria-haspopup="dialog"]'));
  expect(document.body.style.overflow).toBe('');
  open();
  act(() => container.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })));
  expect(container.querySelector('dialog')!.open).toBe(false);
});

it('replaces an unavailable image without substituting an unrelated model', () => {
  render(); open();
  act(() => container.querySelector('img')!.dispatchEvent(new Event('error')));
  expect(container.querySelector('img')).toBeNull();
  expect(container.textContent).toContain('Model preview unavailable');
  render({ modelImage: 'https://example.com/new-model.png' });
  expect(container.querySelector('img')!.src).toBe('https://example.com/new-model.png');
});

it('adapts the card style to the model’s subject', () => {
  expect(getPostcardTheme('Coral Island')).toBe('ocean');
  expect(getPostcardTheme('Garden Cottage')).toBe('nature');
  expect(getPostcardTheme('City Skyline')).toBe('architecture');
  expect(getPostcardTheme('Race Car')).toBe('studio');
});


it('removes the extra popup headings and caption while keeping an accessible label and explanation', () => {
  render(); open();
  const dialog = container.querySelector('dialog')!;
  expect(dialog.getAttribute('aria-label')).toBe('Instructions post card preview');
  const description = document.getElementById(dialog.getAttribute('aria-describedby')!);
  expect(description?.textContent).toBe('Select this option to ship a post card with a QR code link to the instructions.');
  expect(dialog.querySelector('h2, figcaption')).toBeNull();
  expect(dialog.textContent).not.toMatch(/keepsake|Your instructions, on a post card|Example post card for/i);
  expect(dialog.querySelector('h3')?.textContent).toBe(props.modelName);
});


it('identifies the standard 6 by 4 inch card without adding a visible caption', () => {
  render(); open();
  expect(container.querySelector('figure')?.getAttribute('aria-label')).toBe('6 by 4 inch instructions postcard');
  expect(container.querySelector('figcaption')).toBeNull();
});


it('mounts a static 3D view only while the popup is open and preserves the adjusted view when reopening', () => {
  render({ modelContent: '0 FILE Galaxy.mpd' });
  expect(container.querySelector('[data-testid="postcard-viewer"]')).toBeNull();
  open();
  expect(viewer.props.at(-1)).toMatchObject({ modelContent: '0 FILE Galaxy.mpd', presentation: 'model', autoRotate: false, showModelControls: false, showBaseplate: false });
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="postcard-viewer"] button')!.click());
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close postcard preview"]')!.click());
  expect(viewer.captureCurrentViewPng).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-testid="postcard-viewer"]')).toBeNull();
  expect(container.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,adjusted-view');
  open();
  expect(viewer.props.at(-1).initialCameraState).toEqual({ position: { x: 80, y: 20, z: 40 }, target: { x: 1, y: 2, z: 3 } });
  expect(posthog.capture).toHaveBeenCalledWith('order_instructions_postcard_model_adjusted', { generation_id: props.generationId });
});

it('resets the model view without changing the postcard option or QR link', () => {
  render({ modelContent: '0 FILE Galaxy.mpd' }); open();
  const reset = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('Reset view'))!;
  expect(reset().disabled).toBe(true);
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="postcard-viewer"] button')!.click());
  expect(reset().disabled).toBe(false);
  act(() => reset().click());
  expect(viewer.props.at(-1).initialCameraState).toBeUndefined();
  expect(reset().disabled).toBe(true);
  expect(props.onChange).not.toHaveBeenCalled();
  expect(container.querySelector('a.checkout-postcard-qr')!.getAttribute('href')).toContain('g%2F123');
  expect(posthog.capture).toHaveBeenCalledWith('order_instructions_postcard_model_reset', { generation_id: props.generationId });
});
