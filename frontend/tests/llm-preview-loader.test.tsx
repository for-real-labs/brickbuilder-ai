import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRICK_BUILD_SCENES } from '../src/components/brickBuildScenes';
import { LlmPreviewLoader } from '../src/components/LlmPreviewLoader';
import { BRICK_BUILD_CYCLE_MS } from '../src/hooks/useBrickBuildScene';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it.each([0, 0.5, 0.99])('plays all eleven before repeating, without consecutive repeats (random %s)', random => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(random);
  const container = document.createElement('div');
  const root = createRoot(container);
  const scene = () => container.querySelector('svg')!.getAttribute('data-build-scene');
  try {
    act(() => root.render(<React.StrictMode><LlmPreviewLoader compact /></React.StrictMode>));
    const sequence = [scene()];
    const firstSvg = container.querySelector('svg');
    act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS - 1));
    expect(scene()).toBe(sequence[0]);
    act(() => vi.advanceTimersByTime(1));
    sequence.push(scene());
    // A fresh SVG restarts the snap-in animation for the new model.
    expect(container.querySelector('svg')).not.toBe(firstSvg);
    for (let i = 2; i < 33; i++) {
      act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS));
      sequence.push(scene());
    }
    for (let i = 0; i < sequence.length; i += 11) {
      expect(new Set(sequence.slice(i, i + 11))).toEqual(new Set(BRICK_BUILD_SCENES.map(scene => scene.id)));
    }
    sequence.slice(1).forEach((id, i) => expect(id).not.toBe(sequence[i]));
    expect(vi.getTimerCount()).toBe(1);
  } finally { act(() => root.unmount()); }
  expect(vi.getTimerCount()).toBe(0);
});

it('lets cards share animations while keeping separate playback cycles', () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (ids: number[]) => act(() => root.render(<>{ids.map(id =>
    <div key={id} data-loader={id}><LlmPreviewLoader compact /></div>,
  )}</>));
  const scene = (id: number) => container.querySelector(`[data-loader="${id}"] svg`)!.getAttribute('data-build-scene');
  try {
    render([0, 1]);
    expect(scene(0)).toBe(scene(1));
    const initial = scene(0);
    act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS));
    const next = scene(0);
    expect(next).not.toBe(initial);
    render([0, 1, 2]);
    expect(scene(0)).toBe(next);
    expect(scene(2)).toBe(initial);
    act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS));
    expect(scene(2)).toBe(next);
    expect(scene(0)).not.toBe(scene(2));
  } finally { act(() => root.unmount()); }
});

it('pauses playback for preview images and resumes the same card cycle', () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const container = document.createElement('div');
  const root = createRoot(container);
  const render = (preview: boolean) => act(() => root.render(<LlmPreviewLoader previewImageUrl={preview ? '/preview.png' : null} />));
  const scene = () => container.querySelector('svg')!.getAttribute('data-build-scene');
  try {
    render(false);
    const sequence = [scene()];
    act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS));
    sequence.push(scene());
    render(true);
    expect(container.querySelector('svg')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS * 20));
    render(false);
    expect(scene()).toBe(sequence[1]);
    for (let i = 2; i < 11; i++) {
      act(() => vi.advanceTimersByTime(BRICK_BUILD_CYCLE_MS));
      sequence.push(scene());
    }
    expect(new Set(sequence).size).toBe(11);
  } finally { act(() => root.unmount()); }
});

describe('LlmPreviewLoader', () => {
  it('fits compact activity cards without clipping the loading copy', () => {
    const markup = renderToStaticMarkup(<LlmPreviewLoader compact />);
    expect(markup).toContain('height:100%');
    expect(markup).toContain('brick-build-piece');
    expect(markup).not.toContain('One brick at a time');
  });

  it('renders the animated block scene and loading copy without a preview image', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const markup = renderToStaticMarkup(<LlmPreviewLoader />);

    expect(markup).toContain('llm-preview-loader');
    expect(markup).toContain('brick-build-piece');
    expect(markup).toContain('One brick at a time');
    expect(markup).not.toContain('Generation preview');
    expect(markup).toContain('Colorful bricks snapping together to build a little house');
    expect(markup.match(/class="brick-build-piece"/g)).toHaveLength(10);
  });

  it.each(BRICK_BUILD_SCENES.map((scene, index) => [scene.id, index] as const))('can randomly select the %s animation', (id, index) => {
    vi.spyOn(Math, 'random').mockReturnValue((index + 0.5) / BRICK_BUILD_SCENES.length);
    const markup = renderToStaticMarkup(<LlmPreviewLoader compact />);
    expect(markup).toContain(`data-build-scene="${id}"`);
    expect(markup).toContain(`build a ${BRICK_BUILD_SCENES[index].name}`);
    expect(markup.match(/class="brick-build-piece"/g)).toHaveLength(10);
  });

  it('keeps its selection through progress, compact layout, and preview updates', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<LlmPreviewLoader />));
      const selected = container.querySelector('svg')!.getAttribute('data-build-scene');
      random.mockReturnValue(0);
      act(() => root.render(<LlmPreviewLoader compact />));
      expect(container.querySelector('svg')!.getAttribute('data-build-scene')).toBe(selected);
      act(() => root.render(<LlmPreviewLoader previewImageUrl="/preview.png" />));
      expect(container.querySelector('svg')).toBeNull();
      act(() => root.render(<LlmPreviewLoader />));
      expect(container.querySelector('svg')!.getAttribute('data-build-scene')).toBe(selected);
      expect(random).toHaveBeenCalledTimes(1);
    } finally { act(() => root.unmount()); }
  });

  it('offers eleven distinct models including the original house', () => {
    expect(BRICK_BUILD_SCENES).toHaveLength(11);
    expect(new Set(BRICK_BUILD_SCENES.map(scene => scene.id)).size).toBe(11);
    expect(new Set(BRICK_BUILD_SCENES.map(scene => JSON.stringify(scene.bricks))).size).toBe(11);
  });

  it('renders the preview image inside the animated shell when one is available', () => {
    const markup = renderToStaticMarkup(
      <LlmPreviewLoader previewImageUrl="https://example.com/preview.png" />,
    );

    expect(markup).toContain('llm-preview-loader-image-shell');
    expect(markup).toContain('src="https://example.com/preview.png"');
    expect(markup).toContain('alt="Generation preview"');
  });
});
