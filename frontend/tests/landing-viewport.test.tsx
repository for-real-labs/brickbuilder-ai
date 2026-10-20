import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLandingViewport } from '../src/hooks/useLandingViewport';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function Harness({ enabled = true, stage = false }) {
  const ref = useLandingViewport(enabled);
  return <div ref={ref}><header /><div className="landing-page-intro" />{stage && <div className="landing-model-workspace" />}<section className="landing-model-conversation" /></div>;
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
  const intro = container.querySelector('.landing-page-intro')!;
  expect(observe).toHaveBeenCalledWith(conversation);
  expect(observe).toHaveBeenCalledWith(header);
  expect(observe).toHaveBeenCalledWith(intro);
  vi.spyOn(conversation, 'getBoundingClientRect').mockReturnValue({ height: 380 } as DOMRect);
  vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ height: 44 } as DOMRect);
  act(() => notify([], {} as ResizeObserver));
  expect(shell.style.getPropertyValue('--landing-conversation-height')).toBe('380px');
  expect(shell.style.getPropertyValue('--landing-header-height')).toBe('44px');
  vi.spyOn(shell, 'getBoundingClientRect').mockReturnValue({ top: 80 } as DOMRect);
  vi.spyOn(intro, 'getBoundingClientRect').mockReturnValue({ bottom: 320 } as DOMRect);
  act(() => notify([], {} as ResizeObserver));
  expect(shell.style.getPropertyValue('--landing-intro-bottom')).toBe('240px');
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

it('keeps dialogue sizing independent of the viewer that appears after mount', async () => {
  const observe = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor() {}
    observe = observe;
    disconnect = vi.fn();
  });
  act(() => root.render(<Harness />));
  await act(async () => root.render(<Harness stage />));
  const stage = container.querySelector('.landing-model-workspace')!;
  const conversation = container.querySelector<HTMLElement>('.landing-model-conversation')!;
  expect(observe).not.toHaveBeenCalledWith(stage);
  expect(conversation.dataset.overlapsWorkspace).toBeUndefined();
  expect(conversation.style.getPropertyValue('--landing-dialogue-fade-start')).toBe('');
  expect(conversation.style.getPropertyValue('--landing-dialogue-fade-end')).toBe('');
});

it('fits below the iOS app banner and reclaims its space when dismissed or panned above the keyboard', () => {
  let notify!: ResizeObserverCallback;
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { notify = callback; }
    observe = vi.fn();
    disconnect = vi.fn();
  });
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const banner = document.createElement('aside');
  banner.dataset.appBanner = '';
  vi.spyOn(banner, 'getBoundingClientRect').mockReturnValue({ bottom: 80 } as DOMRect);
  document.body.prepend(banner);
  try {
    act(() => root.render(<Harness />));
    const shell = container.firstElementChild as HTMLElement;
    expect(shell.style.getPropertyValue('--landing-viewport-height')).toBe('764px');
    expect(shell.style.getPropertyValue('--landing-viewport-top')).toBe('80px');
    viewport.height = 390;
    viewport.offsetTop = 120;
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(shell.style.getPropertyValue('--landing-viewport-height')).toBe('390px');
    expect(shell.style.getPropertyValue('--landing-viewport-top')).toBe('120px');
    viewport.height = 844;
    viewport.offsetTop = 0;
    banner.remove();
    act(() => notify([], {} as ResizeObserver));
    expect(shell.style.getPropertyValue('--landing-viewport-height')).toBe('844px');
    expect(shell.style.getPropertyValue('--landing-viewport-top')).toBe('0px');
  } finally { banner.remove(); }
});
