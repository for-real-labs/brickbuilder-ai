import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { useLandingHelp, useLandingReveal } from '../src/hooks/useLandingHelp';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Harness({ enabled = true }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useLandingHelp(ref, enabled);
  return <div ref={ref} data-visible={visible} tabIndex={-1}>
    <h1>Build</h1><section className="landing-model-workspace"><canvas /></section>
    <section className="landing-model-conversation"><div className="history" style={{ overflowY: 'auto' }}>History</div><input /><button>Send</button></section>
    <a href="mailto:support@brickbuilder.ai">Support</a>
  </div>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(posthog.capture).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Harness />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const visible = () => host.firstElementChild?.getAttribute('data-visible') === 'true';
const wheel = (target = host.querySelector('h1')!, deltaY = 80, extra = {}) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...extra });
  act(() => target.dispatchEvent(event));
  return event.defaultPrevented;
};

it('reveals on downward scrolling once, returns on dialogue press, and can reveal again', () => {
  expect(visible()).toBe(false);
  expect(wheel()).toBe(true); wheel();
  expect(visible()).toBe(true);
  expect(posthog.capture).toHaveBeenCalledTimes(1);
  expect(posthog.capture).toHaveBeenLastCalledWith('landing_help_toggled', { expanded: true, source: 'scroll' });
  act(() => host.querySelector('.landing-model-conversation')!.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(visible()).toBe(false);
  wheel(); expect(visible()).toBe(true);
  wheel(undefined, -80); expect(visible()).toBe(false);
});

it('returns on composer focus and preserves editing, zooming and model interaction', () => {
  wheel();
  act(() => host.querySelector('input')!.focus());
  expect(visible()).toBe(false);
  expect(wheel()).toBe(false);
  act(() => host.querySelector('input')!.blur());
  for (const selector of ['input', 'button', 'a', 'canvas']) expect(wheel(host.querySelector(selector)!)).toBe(false);
  expect(wheel(undefined, 80, { ctrlKey: true })).toBe(false);
  expect(wheel(undefined, 20, { deltaX: 80 })).toBe(false);
  expect(visible()).toBe(false);
});

it('lets conversation history scroll until its boundary', () => {
  const history = host.querySelector('.history')!;
  Object.defineProperties(history, { clientHeight: { value: 100 }, scrollHeight: { value: 400 } });
  expect(wheel(history)).toBe(false); expect(visible()).toBe(false);
  history.scrollTop = 300;
  expect(wheel(history)).toBe(true); expect(visible()).toBe(true);
  expect(wheel(history, -80)).toBe(false); expect(visible()).toBe(true);
});

it('supports deliberate upward swipes, ignores horizontal and multi-touch gestures, and ends cancelled gestures', () => {
  const target = host.querySelector('h1')!;
  const touch = (type: string, x: number, y: number, count = 1) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) });
    act(() => target.dispatchEvent(event)); return event.defaultPrevented;
  };
  touch('touchstart', 100, 400);
  expect(touch('touchmove', 100, 390)).toBe(false);
  expect(touch('touchmove', 200, 360)).toBe(false);
  expect(touch('touchmove', 100, 330)).toBe(true); expect(visible()).toBe(true);
  touch('touchcancel', 100, 330); wheel(undefined, -80);
  expect(touch('touchmove', 100, 300)).toBe(false);
  touch('touchstart', 100, 400, 2);
  expect(touch('touchmove', 100, 300, 2)).toBe(false); expect(visible()).toBe(false);
});

it('supports keyboard reveal and Escape without taking arrow keys from the input', () => {
  const key = (target: Element, key: string) => act(() => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key })));
  key(host.firstElementChild!, 'PageDown'); expect(visible()).toBe(true);
  key(host.firstElementChild!, 'Escape'); expect(visible()).toBe(false);
  key(host.querySelector('input')!, 'ArrowDown'); expect(visible()).toBe(false);
});

it('leaves disabled pages alone and removes listeners', () => {
  const shell = host.firstElementChild!;
  const remove = vi.spyOn(shell, 'removeEventListener');
  act(() => root.render(<Harness enabled={false} />));
  expect(wheel()).toBe(false); expect(visible()).toBe(false);
  expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('touchmove', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
});

function StagedHarness() {
  const ref = useRef<HTMLDivElement>(null);
  const stage = useLandingReveal(ref, true, true);
  return <div ref={ref} data-stage={stage}><h1>Welcome</h1></div>;
}
it('reveals stats before support and reverses without scrolling the page', () => {
  act(() => root.render(<StagedHarness />));
  const stage = () => host.firstElementChild?.getAttribute('data-stage');
  expect(stage()).toBe('0');
  expect(wheel(undefined, 2000)).toBe(true);
  expect(stage()).toBe('1');
  wheel(undefined, 100);
  expect(stage()).toBe('2');
  wheel(undefined, -100);
  expect(stage()).toBe('1');
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(stage()).toBe('0');
});
it('uses incremental swipe distance for staged reveals', () => {
  act(() => root.render(<StagedHarness />));
  const touch = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: [{ clientX: 100, clientY: y }] });
    act(() => host.querySelector('h1')!.dispatchEvent(event));
  };
  touch('touchstart', 500); touch('touchmove', 420);
  expect(host.firstElementChild?.getAttribute('data-stage')).toBe('1');
  touch('touchmove', 400);
  expect(host.firstElementChild?.getAttribute('data-stage')).toBe('1');
  touch('touchmove', 230);
  expect(host.firstElementChild?.getAttribute('data-stage')).toBe('2');
});
