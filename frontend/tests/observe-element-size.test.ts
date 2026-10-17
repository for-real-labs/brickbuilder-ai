import { afterEach, expect, it, vi } from 'vitest';
import { observeElementSize } from '../src/utils/observeElementSize';

afterEach(() => vi.unstubAllGlobals());

it('updates the viewport when its container changes layout without a window resize', () => {
  let notify!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const element = document.createElement('div');
  let height = 160;
  Object.defineProperty(element, 'clientWidth', { get: () => 320 });
  Object.defineProperty(element, 'clientHeight', { get: () => height });
  const size = vi.fn();
  const stop = observeElementSize(element, size);
  expect(size).toHaveBeenLastCalledWith(320, 160);
  height = 300;
  notify([], {} as ResizeObserver);
  expect(size).toHaveBeenLastCalledWith(320, 300);
  height = 0;
  notify([], {} as ResizeObserver);
  expect(size).toHaveBeenCalledTimes(2);
  height = 220;
  notify([], {} as ResizeObserver);
  expect(size).toHaveBeenLastCalledWith(320, 220);
  stop();
  expect(disconnect).toHaveBeenCalledOnce();
});

it('supports window resizing without ResizeObserver and releases the listener', () => {
  vi.stubGlobal('ResizeObserver', undefined);
  const element = document.createElement('div');
  let width = 320;
  Object.defineProperty(element, 'clientWidth', { get: () => width });
  Object.defineProperty(element, 'clientHeight', { get: () => 160 });
  const size = vi.fn();
  const stop = observeElementSize(element, size);
  width = 640;
  window.dispatchEvent(new Event('resize'));
  expect(size).toHaveBeenLastCalledWith(640, 160);
  stop();
  size.mockClear();
  window.dispatchEvent(new Event('resize'));
  expect(size).not.toHaveBeenCalled();
});
