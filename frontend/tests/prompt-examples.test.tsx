import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PROMPT_EXAMPLES, pickPromptExampleIndex } from '../src/utils/promptExamples';
import { usePromptTypewriter } from '../src/hooks/usePromptTypewriter';

afterEach(() => vi.useRealTimers());

it('offers 1,000 additional unique, concise examples and keeps the originals', () => {
  expect(PROMPT_EXAMPLES).toHaveLength(1006);
  expect(new Set(PROMPT_EXAMPLES).size).toBe(1006);
  expect(PROMPT_EXAMPLES).toContain('a dachshund in sunglasses');
  expect(PROMPT_EXAMPLES.every(phrase => phrase.length < 100 && !phrase.includes('undefined'))).toBe(true);
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
  expect(pickPromptExampleIndex(1005)).toBe(1004);
});

it('types a random example, pauses when disabled, then picks another after deletion', async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  function Harness({ enabled }: {enabled: boolean}) { return <p>{usePromptTypewriter(enabled)}</p>; }
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<Harness enabled />));
    for (let i = 0; i < 'a unicorn'.length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    }
    expect(container.textContent?.replace('|', '')).toBe('a unicorn');
    act(() => root.render(<Harness enabled={false} />));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toBe('a unicorn');
    random.mockReturnValue(0.5);
    act(() => root.render(<Harness enabled />));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    for (let i = 0; i < 'a unicorn'.length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(35); });
    }
    const selected = PROMPT_EXAMPLES[pickPromptExampleIndex(0)];
    for (let i = 0; i < selected.length; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(70); });
    }
    expect(container.textContent?.replace('|', '')).toBe(selected);
  } finally { act(() => root.unmount()); }
});
