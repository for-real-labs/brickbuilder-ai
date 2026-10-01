import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

import { BRICK_BUILD_SCENES } from '../src/components/brickBuildScenes';
import { LlmPreviewLoader } from '../src/components/LlmPreviewLoader';

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
