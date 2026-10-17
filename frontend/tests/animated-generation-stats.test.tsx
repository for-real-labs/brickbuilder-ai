import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnimatedGenerationStats } from '../src/hooks/useAnimatedGenerationStats';
import type { GenerationStats } from '../src/services/getGenerationStatsApi';

describe('generation stats ticker', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let callbacks: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let motion: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  function Counter({ totals }: { totals: GenerationStats | null }) {
    const displayed = useAnimatedGenerationStats(totals);
    return <span>{displayed ? `${displayed.generation_count}/${displayed.brick_count}` : '—'}</span>;
  }
  const render = (models: number, bricks: number) => act(() => root.render(<Counter totals={{ generation_count: models, brick_count: bricks }} />));
  const values = () => container.textContent!.split('/').map(Number);
  const advance = (elapsed: number) => act(() => {
    vi.advanceTimersByTime(elapsed);
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach(callback => callback(performance.now()));
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    container = document.createElement('div');
    root = createRoot(container);
    callbacks = new Map();
    nextFrame = 0;
    motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => motion));
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
      callbacks.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(id => callbacks.delete(id)));
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('loads the exact real totals before increasing both counters together', () => {
    act(() => root.render(<Counter totals={null} />));
    expect(container.textContent).toBe('—');
    expect(vi.getTimerCount()).toBe(0);
    render(1000, 10000);
    expect(values()).toEqual([1000, 10000]);
    advance(2999);
    expect(values()).toEqual([1000, 10000]);
    advance(1);
    expect(values()).toEqual([1001, 10001]);
    advance(500);
    expect(values()).toEqual([1001, 10008]);
    advance(500);
    expect(values()).toEqual([1001, 10010]);
    advance(2000);
    expect(values()).toEqual([1002, 10011]);
  });

  it.each([[0, 1000], [0.5, 3000], [1, 5000]])('uses random %s for a %sms interval between model ticks', (random, interval) => {
    vi.mocked(Math.random).mockReturnValue(random);
    render(100, 10000);
    advance(interval - 1);
    expect(values()).toEqual([100, 10000]);
    advance(1);
    expect(values()).toEqual([101, 10001]);
    advance(interval - 1);
    expect(values()[0]).toBe(101);
    advance(1);
    expect(values()[0]).toBe(102);
    expect(values()[1]).toBeGreaterThan(10001);
  });

  it('adds refreshed real totals to accumulated simulated increases without restarting a burst', () => {
    render(100, 10000);
    advance(3000);
    advance(500);
    expect(values()).toEqual([101, 10087]);
    render(103, 12401);
    expect(values()).toEqual([101, 10087]);
    advance(500);
    expect(values()).toEqual([101, 10100]);
    advance(2000);
    expect(values()).toEqual([105, 10101]);
    advance(1000);
    expect(values()).toEqual([105, 12601]);
    render(103, 12401);
    advance(2000);
    expect(values()[0]).toBe(106);
    advance(1000);
    expect(values()).toEqual([106, 12701]);
  });

  it('does not postpone ticks when unchanged totals are polled', () => {
    render(100, 10000);
    advance(2500);
    render(100, 10000);
    advance(500);
    expect(values()).toEqual([101, 10001]);
  });

  it('keeps brick-only real updates paired with the next model tick and ignores lower totals', () => {
    render(100, 10000);
    render(100, 12000);
    expect(values()).toEqual([100, 10000]);
    advance(3000);
    advance(1000);
    expect(values()).toEqual([101, 12100]);
    render(90, 9000);
    expect(values()).toEqual([101, 12100]);
    advance(2000);
    advance(1000);
    expect(values()).toEqual([102, 12200]);
  });

  it('keeps increasing past a batch of 100 pairs without decreasing or losing additions', () => {
    render(100, 10000);
    let previous = values();
    for (let step = 1; step <= 105; step++) {
      advance(step === 1 ? 3000 : 2000);
      const started = values();
      expect(started[0]).toBe(previous[0] + 1);
      expect(started[1]).toBeGreaterThan(previous[1]);
      advance(1000);
      expect(values()).toEqual([100 + step, 10000 + step * 100]);
      previous = values();
    }
    expect(vi.getTimerCount()).toBe(1);
  });

  it('finishes delayed animation frames before the next pair, including at one-second intervals', () => {
    vi.mocked(Math.random).mockReturnValue(0);
    render(100, 10000);
    act(() => vi.advanceTimersByTime(1000));
    expect(values()).toEqual([101, 10001]);
    act(() => vi.advanceTimersByTime(1000));
    expect(values()).toEqual([102, 10051]);
    expect(callbacks.size).toBe(1);
    advance(500);
    expect(values()).toEqual([102, 10093]);
    advance(500);
    expect(values()).toEqual([103, 10101]);
  });

  it('uses positive brick increases even when the real totals are zero', () => {
    render(0, 0);
    expect(values()).toEqual([0, 0]);
    advance(3000);
    expect(values()).toEqual([1, 1]);
    advance(1000);
    expect(values()).toEqual([1, 1000]);
  });

  it('respects reduced motion while continuing paired updates and finishes an active burst on preference change', () => {
    motion.matches = true;
    render(100, 10000);
    advance(3000);
    expect(values()).toEqual([101, 10100]);
    expect(callbacks.size).toBe(0);
    motion.matches = false;
    act(() => motion.addEventListener.mock.calls.at(-1)![1]());
    advance(3000);
    advance(500);
    expect(values()).toEqual([102, 10187]);
    motion.matches = true;
    act(() => motion.addEventListener.mock.calls.at(-1)![1]());
    expect(values()).toEqual([102, 10200]);
    expect(callbacks.size).toBe(0);
    advance(2500);
    expect(values()).toEqual([103, 10300]);
  });

  it('runs only one ticker in Strict Mode and cancels frames, pauses, and listeners on unmount', () => {
    act(() => root.render(<StrictMode><Counter totals={{ generation_count: 100, brick_count: 10000 }} /></StrictMode>));
    expect(values()).toEqual([100, 10000]);
    expect(vi.getTimerCount()).toBe(1);
    advance(3000);
    expect(values()).toEqual([101, 10001]);
    expect(callbacks.size).toBe(1);
    act(() => root.unmount());
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(motion.removeEventListener).toHaveBeenCalledWith('change', motion.addEventListener.mock.calls.at(-1)![1]);
    root = createRoot(container);
  });
});
