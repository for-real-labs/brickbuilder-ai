import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PROMPT_EXAMPLES, pickPromptExampleIndex } from '../src/utils/promptExamples';
import { usePromptTypewriter } from '../src/hooks/usePromptTypewriter';

afterEach(() => vi.useRealTimers());

it('offers unique, short ideas across recognizable subjects and varied formats', () => {
  expect(PROMPT_EXAMPLES.length).toBeGreaterThan(200);
  expect(new Set(PROMPT_EXAMPLES).size).toBe(PROMPT_EXAMPLES.length);
  expect(PROMPT_EXAMPLES.every(phrase => phrase.trim() === phrase && phrase.length > 0 && phrase.length <= 40)).toBe(true);
  for (const subject of ['Mario', 'Pikachu', 'Taylor Swift', 'the Eiffel Tower', 'a Porsche 911', 'Darth Vader', 'the Nike swoosh']) {
    expect(PROMPT_EXAMPLES).toContain(subject);
  }
  expect(PROMPT_EXAMPLES).toContain('Messi scoring a goal');
  expect(PROMPT_EXAMPLES).toContain('a rocket launch');
  expect(PROMPT_EXAMPLES.filter(phrase => !phrase.includes(' ')).length).toBeGreaterThan(30);
});

it('can select every example and skips the previous example at both random boundaries', () => {
  const random = vi.spyOn(Math, 'random');
  PROMPT_EXAMPLES.forEach((_, index) => {
    random.mockReturnValue((index + 0.5) / PROMPT_EXAMPLES.length);
    expect(pickPromptExampleIndex()).toBe(index);
  });
  random.mockReturnValue(0);
  expect(pickPromptExampleIndex(0)).toBe(1);
  random.mockReturnValue(0.99999);
  expect(pickPromptExampleIndex(PROMPT_EXAMPLES.length - 1)).toBe(PROMPT_EXAMPLES.length - 2);
});

it('types a random example, pauses when disabled, then picks another after deletion', async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  function Harness({ enabled }: {enabled: boolean}) { return <p>{usePromptTypewriter(enabled)}</p>; }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<Harness enabled />));
    for (let i = 0; i < PROMPT_EXAMPLES[0].length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    }
    expect(container.textContent?.replace('|', '')).toBe(PROMPT_EXAMPLES[0]);
    act(() => root.render(<Harness enabled={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toBe(PROMPT_EXAMPLES[0]);
    random.mockReturnValue(0.5);
    act(() => root.render(<Harness enabled />));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    for (let i = 0; i < PROMPT_EXAMPLES[0].length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(35); });
    }
    const selected = PROMPT_EXAMPLES[pickPromptExampleIndex(0)];
    for (let i = 0; i < selected.length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    }
    expect(container.textContent?.replace('|', '')).toBe(selected);
  } finally { act(() => root.unmount()); }
});
