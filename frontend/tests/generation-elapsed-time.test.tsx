import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GenerationElapsedTime } from '../src/components/GenerationElapsedTime';

afterEach(() => vi.useRealTimers());

it('derives elapsed time from the saved timestamp and continues after returning', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T18:00:30Z'));
  const container = document.createElement('div');
  let root = createRoot(container);
  const startedAt = '2026-10-01T18:00:00+00:00';
  act(() => root.render(<GenerationElapsedTime startedAt={startedAt} />));
  expect(container.textContent).toBe('Building for 30s');
  act(() => vi.advanceTimersByTime(5_000));
  expect(container.textContent).toBe('Building for 35s');
  act(() => root.unmount());
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(new Date('2026-10-01T18:01:30Z'));
  root = createRoot(container);
  act(() => root.render(<GenerationElapsedTime startedAt={startedAt} />));
  expect(container.textContent).toBe('Building for 1m 30s');
  act(() => root.unmount());
});

it('handles UTC timestamps without an offset and updates from wall time after a background pause', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T18:00:30Z'));
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<GenerationElapsedTime startedAt="2026-10-01T18:00:00.000000" />));
  expect(container.textContent).toBe('Building for 30s');
  vi.setSystemTime(new Date('2026-10-01T18:02:00Z'));
  act(() => vi.advanceTimersByTime(1_000));
  expect(container.textContent).toBe('Building for 2m 1s');
  act(() => root.unmount());
});

it.each([undefined, '', 'not a timestamp'])('hides the clock when no valid start exists: %s', startedAt => {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(<GenerationElapsedTime startedAt={startedAt} />));
  expect(container.textContent).toBe('');
  act(() => root.unmount());
});
