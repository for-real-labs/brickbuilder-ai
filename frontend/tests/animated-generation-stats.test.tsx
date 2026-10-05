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
  let now: number;
  let motion: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> };

  function Counter({ totals }: { totals: GenerationStats | null }) {
    const displayed = useAnimatedGenerationStats(totals);
    return <span>{displayed ? `${displayed.generation_count}/${displayed.brick_count}` : '—'}</span>;
  }
  const render = (models: number, bricks: number) => act(() => root.render(<Counter totals={{ generation_count: models, brick_count: bricks }} />));
  const advance = (time: number) => {
    now = time;
    const pending = [...callbacks.values()];
    callbacks.clear();
    act(() => pending.forEach(callback => callback(time)));
  };

  beforeEach(() => {
    container = document.createElement('div');
    root = createRoot(container);
    callbacks = new Map();
    nextFrame = 0;
    now = 0;
    motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal('matchMedia', vi.fn(() => motion));
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
      callbacks.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(id => callbacks.delete(id)));
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('shows initial totals immediately, then finishes three new models and all their bricks together', () => {
    act(() => root.render(<Counter totals={null} />));
    expect(container.textContent).toBe('—');
    render(100, 10000);
    expect(container.textContent).toBe('100/10000');
    render(103, 12400);
    advance(500);
    expect(container.textContent).toBe('102/12100');
    advance(999);
    expect(container.textContent).toBe('102/12399');
    advance(1000);
    expect(container.textContent).toBe('103/12400');
    expect(callbacks.size).toBe(0);
  });

  it('does not restart for unchanged polls and continues from the displayed totals when interrupted', () => {
    render(100, 10000);
    render(103, 12400);
    advance(500);
    render(103, 12400);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    render(106, 15000);
    expect(container.textContent).toBe('102/12100');
    expect(callbacks.size).toBe(1);
    advance(1000);
    expect(container.textContent).toBe('105/14637');
    advance(1500);
    expect(container.textContent).toBe('106/15000');
  });

  it('animates bricks arriving separately and applies downward corrections immediately', () => {
    render(100, 10000);
    render(100, 12400);
    advance(500);
    expect(container.textContent).toBe('100/12100');
    render(99, 9000);
    expect(container.textContent).toBe('99/9000');
    expect(callbacks.size).toBe(0);
  });

  it('respects reduced motion, including when enabled during an animation', () => {
    render(100, 10000);
    motion.matches = true;
    render(103, 12400);
    expect(container.textContent).toBe('103/12400');
    expect(callbacks.size).toBe(0);
    motion.matches = false;
    render(106, 15000);
    motion.matches = true;
    act(() => motion.addEventListener.mock.calls[0][1]());
    expect(container.textContent).toBe('106/15000');
    expect(callbacks.size).toBe(0);
  });

  it('cancels pending animation frames and preference listeners on unmount', () => {
    render(100, 10000);
    render(103, 12400);
    act(() => root.unmount());
    expect(callbacks.size).toBe(0);
    expect(motion.removeEventListener).toHaveBeenCalledWith('change', motion.addEventListener.mock.calls[0][1]);
    root = createRoot(container);
  });
});
