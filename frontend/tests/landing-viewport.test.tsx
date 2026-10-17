import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLandingViewport } from '../src/hooks/useLandingViewport';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Harness({ enabled = true }) {
  const ref = useLandingViewport(enabled);
  return <div ref={ref}><header /><section className="landing-model-conversation" /></div>;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('follows keyboard resize and visual viewport panning, then removes its listeners', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const remove = vi.spyOn(viewport, 'removeEventListener');
  act(() => root.render(<Harness />));
  const style = container.firstElementChild!.getAttribute('style');
  expect(style).toContain('--landing-viewport-height: 844px');
  expect(style).toContain('--landing-viewport-top: 0px');

  viewport.height = 390;
  act(() => viewport.dispatchEvent(new Event('resize')));
  viewport.offsetTop = 120;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--landing-viewport-height')).toBe('390px');
  expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--landing-viewport-top')).toBe('120px');

  viewport.height = 844;
  viewport.offsetTop = 0;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--landing-viewport-height')).toBe('844px');
  expect((container.firstElementChild as HTMLElement).style.getPropertyValue('--landing-viewport-top')).toBe('0px');
  act(() => root.render(<Harness enabled={false} />));
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
});

it('reserves the dialogue height as content grows and disconnects its observer on unmount', () => {
  let notify!: ResizeObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  act(() => root.render(<Harness />));
  const shell = container.firstElementChild as HTMLElement;
  const conversation = container.querySelector('section')!;
  const header = container.querySelector('header')!;
  expect(observe).toHaveBeenCalledWith(conversation);
  expect(observe).toHaveBeenCalledWith(header);
  vi.spyOn(conversation, 'getBoundingClientRect').mockReturnValue({ height: 380 } as DOMRect);
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);
  act(() => notify([], {} as ResizeObserver));
  expect(shell.style.getPropertyValue('--landing-conversation-height')).toBe('380px');
  expect(shell.style.getPropertyValue('--landing-header-height')).toBe('44px');
  act(() => root.render(null));
  expect(disconnect).toHaveBeenCalledOnce();
});

it('uses window height when the visual viewport API is unavailable and leaves disabled pages alone', () => {
  vi.stubGlobal('visualViewport', undefined);
  vi.stubGlobal('innerHeight', 700);
  act(() => root.render(<Harness enabled={false} />));
  expect(container.firstElementChild!.getAttribute('style')).toBeNull();
  act(() => root.render(<Harness />));
  const shell = container.firstElementChild as HTMLElement;
  expect(shell.style.getPropertyValue('--landing-viewport-height')).toBe('700px');
  vi.stubGlobal('innerHeight', 500);
  act(() => window.dispatchEvent(new Event('resize')));
  expect(shell.style.getPropertyValue('--landing-viewport-height')).toBe('500px');
});
