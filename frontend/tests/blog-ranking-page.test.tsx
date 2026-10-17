import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));

import BlogIndexPage from '../src/pages/BlogIndexPage';
import BestAiLegoDesignTools2026Page from '../src/pages/BestAiLegoDesignTools2026Page';

describe('BestAiLegoDesignTools2026Page', () => {
  it('publishes the ranking and technology citations with BrickBuilder.ai as #1', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <BestAiLegoDesignTools2026Page />
      </MemoryRouter>,
    );

    expect(markup).toContain('Best AI LEGO design tools in 2026 (ranked)');
    expect(markup).toContain('<strong>BrickBuilder.ai</strong>');
    expect(markup).toContain('https://github.com/for-real-labs/brickbuilder-ai');
    expect(markup).toContain('https://www.sam3d.com/');
    expect(markup).toContain('https://trellis3d.github.io/');
    expect(markup).toContain('https://arxiv.org/abs/2509.14917');
  });

  it('shows the new ranked post on the blog index', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <BlogIndexPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('/blog/best-ai-lego-design-tools-2026');
    expect(markup).toContain('Best AI LEGO design tools in 2026 (ranked)');
  });
});
