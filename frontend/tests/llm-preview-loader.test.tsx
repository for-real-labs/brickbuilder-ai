import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { LlmPreviewLoader } from '../src/components/LlmPreviewLoader';

describe('LlmPreviewLoader', () => {
  it('fits compact activity cards without clipping the loading copy', () => {
    const markup = renderToStaticMarkup(<LlmPreviewLoader compact />);
    expect(markup).toContain('height:100%');
    expect(markup).toContain('brick-build-piece');
    expect(markup).not.toContain('One brick at a time');
  });

  it('renders the animated block scene and loading copy without a preview image', () => {
    const markup = renderToStaticMarkup(<LlmPreviewLoader />);

    expect(markup).toContain('llm-preview-loader');
    expect(markup).toContain('brick-build-piece');
    expect(markup).toContain('One brick at a time');
    expect(markup).not.toContain('Generation preview');
    expect(markup).toContain('Colorful bricks snapping together to build a little house');
    expect(markup.match(/class="brick-build-piece"/g)).toHaveLength(10);
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
