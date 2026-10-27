import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import FallingBricks from '../src/components/FallingBricks';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let frame: FrameRequestCallback;
let now: number;
let mobile = false;
const translate = vi.fn();
const context = {
  save: vi.fn(), restore: vi.fn(), translate, rotate: vi.fn(), beginPath: vi.fn(),
  moveTo: vi.fn(), arcTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), arc: vi.fn(),
  setTransform: vi.fn(), scale: vi.fn(), clearRect: vi.fn(),
};
function tick(milliseconds = 0) {
  now += milliseconds;
  translate.mockClear();
  act(() => frame(now));
  return translate.mock.calls.map(([x, y]) => ({ x, y }));
}
beforeEach(() => {
  now = 0; mobile = false;
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('matchMedia', () => ({ matches: mobile }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockImplementation(() => mobile ? 390 : 1440);
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(844);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([false, true])('fills every vertical band on the first frame (mobile: %s)', isMobile => {
  mobile = isMobile;
  act(() => root.render(<FallingBricks />));
  const positions = tick();
  const count = mobile ? 13 : 22;
  expect(positions).toHaveLength(count);
  positions.forEach(({ x, y }, index) => {
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(mobile ? 390 : 1440);
    expect(y).toBeGreaterThanOrEqual(index * 844 / count);
    expect(y).toBeLessThan((index + 1) * 844 / count);
  });
});

it('continues falling and recycles above the screen instead of repopulating inside it', () => {
  act(() => root.render(<FallingBricks />));
  const first = tick();
  const next = tick(50);
  expect(next.every((position, index) => position.y > first[index].y)).toBe(true);
  let recycled = false;
  for (let i = 0; i < 100; i++) {
    if (tick(50).some(position => position.y < 0)) { recycled = true; break; }
  }
  expect(recycled).toBe(true);
});
