import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
import TermsOfServicePage from '../src/pages/TermsOfServicePage';
import { renderLegalDocument } from '../src/legal-prerender';

describe('directory legal pages', () => {
  const shell = '<html><head><title>BrickBuilder</title><link rel="canonical" href="https://brickbuilder.ai/" /></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>';

  it('makes full policy disclosures accessible without executing JavaScript', () => {
    const privacy = renderLegalDocument(shell, 'privacy');
    expect(privacy).toContain('Retention and deletion');
    expect(privacy).toContain('OpenAI, Anthropic, fal.ai, and RunPod');
    expect(privacy).toContain('href="https://brickbuilder.ai/privacy"');
    expect(privacy).toContain('src="/assets/app.js"');
    expect(privacy).not.toContain('<div id="root"></div>');
  });

  it('publishes the owner-provided free service and age policy consistently', () => {
    const terms = renderLegalDocument(shell, 'terms');
    expect(terms).toContain('Operator: Jake Johnson');
    expect(terms).toContain('at least 13 years old');
    expect(terms).toContain('free of charge');
    expect(terms).toContain('free usage allowances, not purchased currency');
    expect(terms).toContain('revoke the connection');
    expect(terms).toContain('href="mailto:support@brickbuilder.ai"');
    expect(terms).toContain('href="https://brickbuilder.ai/terms"');
  });

  it('rejects unsupported paths or a missing application shell', () => {
    expect(() => renderLegalDocument(shell, '../account')).toThrow();
    expect(() => renderLegalDocument('<html></html>', 'privacy')).toThrow();
  });

  it('keeps terms readable in the application and links to privacy', () => {
    const markup = renderToStaticMarkup(<MemoryRouter><TermsOfServicePage /></MemoryRouter>);
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('geometry checks');
  });
});
