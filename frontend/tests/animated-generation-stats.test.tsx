import React from 'react';
import { act } from 'react';
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
  const settle = () => {
    for (let step = 0; step < 360; step++) advance(500);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
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

  it('adds one model per burst, then counts up its proportional bricks', () => {
    act(() => root.render(<Counter totals={null} />));
    expect(container.textContent).toBe('—');
    render(10000, 1000000);
    expect(values()).toEqual([9975, 997500]);
    advance(1799);
    expect(values()).toEqual([9975, 997500]);
    advance(1);
    expect(values()).toEqual([9976, 997500]);
    advance(500);
    expect(values()).toEqual([9976, 997587]);
    advance(500);
    expect(values()).toEqual([9976, 997600]);
    advance(1799);
    expect(values()).toEqual([9976, 997600]);
    advance(1);
    expect(values()).toEqual([9977, 997600]);
    advance(1000);
    expect(values()).toEqual([9977, 997700]);
  });

  it('varies the pause for the shared model and bricks burst', () => {
    vi.mocked(Math.random).mockReturnValue(0.5);
    render(10000, 1000000);
    advance(3499);
    expect(values()).toEqual([9975, 997500]);
    advance(1);
    expect(values()).toEqual([9976, 997500]);
    advance(1000);
    expect(values()).toEqual([9976, 997600]);
  });

  it('never overshoots or runs backward, and stops at the confirmed totals', () => {
    render(10000, 1000000);
    let previous = values();
    for (let step = 0; step < 360; step++) {
      advance(500);
      const current = values();
      expect(current[0]).toBeGreaterThanOrEqual(previous[0]);
      expect(current[1]).toBeGreaterThanOrEqual(previous[1]);
      expect(current[0]).toBeLessThanOrEqual(10000);
      expect(current[1]).toBeLessThanOrEqual(1000000);
      previous = current;
    }
    expect(container.textContent).toBe('10000/1000000');
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    render(10000, 1000000);
    advance(30000);
    expect(container.textContent).toBe('10000/1000000');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not restart unchanged polls or jump to a new target during a burst', () => {
    render(10000, 1000000);
    advance(1000);
    render(10000, 1000000);
    advance(800);
    advance(500);
    expect(values()).toEqual([9976, 997587]);
    const interrupted = container.textContent;
    render(10003, 1002400);
    expect(container.textContent).toBe(interrupted);
    settle();
    expect(container.textContent).toBe('10003/1002400');
  });

  it('distributes newly recorded bricks across their models and includes rounding remainders', () => {
    motion.matches = true;
    render(100, 10000);
    motion.matches = false;
    render(103, 12401);
    advance(1800);
    expect(values()).toEqual([101, 10000]);
    advance(1000);
    expect(values()).toEqual([101, 10800]);
    advance(1800);
    expect(values()).toEqual([102, 10800]);
    advance(1000);
    expect(values()).toEqual([102, 11601]);
    advance(1800);
    expect(values()).toEqual([103, 11601]);
    advance(1000);
    expect(values()).toEqual([103, 12401]);
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes an interrupted brick count without incrementing the same model twice', () => {
    render(1, 100);
    advance(1800);
    advance(500);
    expect(values()).toEqual([1, 87]);
    render(2, 500);
    expect(values()).toEqual([1, 87]);
    advance(1000);
    expect(values()).toEqual([1, 100]);
    advance(1800);
    expect(values()).toEqual([2, 100]);
    advance(1000);
    expect(values()).toEqual([2, 500]);
  });

  it('applies corrected totals and bounds small and zero totals', () => {
    render(10000, 1000000);
    render(9900, 1000000);
    expect(values()).toEqual([9900, 1000000]);
    render(0, 1);
    expect(values()[0]).toBe(0);
    expect(values()[1]).toBeLessThanOrEqual(1);
    settle();
    expect(container.textContent).toBe('0/1');
  });

  it('respects reduced motion on load and when enabled during a burst', () => {
    motion.matches = true;
    render(10000, 1000000);
    expect(container.textContent).toBe('10000/1000000');
    expect(vi.getTimerCount()).toBe(0);
    motion.matches = false;
    render(10003, 1002400);
    advance(1700);
    motion.matches = true;
    act(() => motion.addEventListener.mock.calls.at(-1)![1]());
    expect(container.textContent).toBe('10003/1002400');
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels pending frames, pauses, and preference listeners on unmount', () => {
    render(10000, 1000000);
    advance(1800);
    expect(callbacks.size).toBeGreaterThan(0);
    act(() => root.unmount());
    expect(callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(motion.removeEventListener).toHaveBeenCalledWith('change', motion.addEventListener.mock.calls[0][1]);
    root = createRoot(container);
  });
});
