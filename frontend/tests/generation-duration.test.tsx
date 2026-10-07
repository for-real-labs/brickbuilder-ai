import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { GenerationDuration, formatGenerationDuration } from '../src/components/GenerationDuration';

it.each([[0, '0s'], [59.8, '59s'], [60, '1m 0s'], [125, '2m 5s'], [3600, '1h 0m'], [7260, '2h 1m']])('formats duration %s as %s', (seconds, expected) => {
  expect(formatGenerationDuration(Number(seconds))).toBe(expected);
});

it('does not fabricate durations for historical, missing or invalid values', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    for (const seconds of [null, undefined, -1, NaN, Infinity]) {
      act(() => root.render(<GenerationDuration seconds={seconds} />));
      expect(container.textContent).toBe('');
    }
    act(() => root.render(<GenerationDuration seconds={0} />));
    expect(container.textContent).toBe('Generation time: 0s');
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  } finally { act(() => root.unmount()); }
});

it('keeps the full duration label accessible on compact featured cards', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<GenerationDuration seconds={75} compact />));
    expect(container.textContent).toBe('1m 15s');
    expect(container.querySelector('p')?.getAttribute('aria-label')).toBe('Generation time: 1m 15s');
  } finally { act(() => root.unmount()); }
});
