import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import VideoPage from '../src/pages/VideoPage';

vi.mock('../src/components/FallingBricks', () => ({ default: () => null }));

it('types once under StrictMode, holds the completed message for three seconds, and cleans up', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  const root = createRoot(container);
  const advance = async (ms: number) => {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  };
  const lines = () => Array.from(container.querySelectorAll('p')).map(p => p.getAttribute('aria-label'));
  try {
    act(() => root.render(<StrictMode><VideoPage /></StrictMode>));
    await advance(1500);
    expect(lines()).toEqual(['use for free at', '']);
    await advance(380);
    expect(lines()).toEqual(['use for free at', 't']);
    await advance(1440);
    expect(lines()).toEqual(['use for free at', 'trybrickbuilder.com']);
    await advance(2999);
    expect(lines()).toEqual(['use for free at', 'trybrickbuilder.com']);
    await advance(1);
    expect(lines()).toEqual(['', '']);
    await advance(100);
    expect(lines()).toEqual(['u', '']);
  } finally {
    act(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
