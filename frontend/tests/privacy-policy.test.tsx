import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/components/SEO', () => ({ SEO: () => null }));

import { SiteFooter } from '../src/components/SiteFooter';
import PrivacyPolicyPage from '../src/pages/PrivacyPolicyPage';

describe('PrivacyPolicyPage', () => {
  it('publishes the disclosures and deletion contact required for the mobile app', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PrivacyPolicyPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('Privacy Policy');
    expect(markup).toContain('October 2, 2026');
    expect(markup).toContain('Camera and photo library access');
    expect(markup).toContain('OpenAI, Anthropic, fal.ai, and RunPod');
    expect(markup).toContain('Retention and deletion');
    expect(markup).toContain('AI processing and your permission');
    expect(markup).toContain('withdraw permission');
    expect(markup).toContain('same or equal protection');
    expect(markup).toContain('support@brickbuilder.ai');
    expect(markup).toContain('do not sell your personal information');
  });

  it('links to the privacy policy from the shared in-app footer', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <SiteFooter />
      </MemoryRouter>,
    );

    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('Privacy Policy');
  });
});
