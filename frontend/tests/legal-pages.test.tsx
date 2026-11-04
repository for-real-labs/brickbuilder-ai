import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it } from 'vitest';

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

  it('publishes the subscription requirement, recurring billing, cancellation, and age policy consistently', () => {
    const terms = renderLegalDocument(shell, 'terms');
    expect(terms).toContain('Operator: Jake Johnson');
    expect(terms).toContain('at least 13 years old');
    expect(terms).toContain('An active subscription is required');
    const text = new DOMParser().parseFromString(terms, 'text/html').body.textContent;
    expect(text).toContain('Builder subscriptions include 10% off the regular price of LEGO® compatible bricks');
    expect(text).toContain('discounted price of LEGO® compatible bricks');
    expect(terms).toContain('Creator and existing Master Builder subscriptions include 20% off.');
    expect(terms).toContain('renew automatically each month until canceled');
    expect(terms).toContain('My billing → Cancel subscription');
    expect(terms).toContain('Web subscription monthly credits reset without rollover');
    expect(terms).toContain('One-time credit packs and credits purchased through Apple subscriptions roll over and never expire');
    expect(terms).toContain('Manage Apple subscription');
    expect(terms).toContain('revoke the connection');
    expect(terms).toContain('href="mailto:support@brickbuilder.ai"');
    expect(terms).toContain('href="https://brickbuilder.ai/terms"');
  });

  it('rejects unsupported paths or a missing application shell', () => {
    expect(() => renderLegalDocument(shell, '../account')).toThrow();
    expect(() => renderLegalDocument('<html></html>', 'privacy')).toThrow();
  });

  it('keeps terms readable in the application and links to privacy', () => {
    const markup = renderToStaticMarkup(<HelmetProvider><MemoryRouter><TermsOfServicePage /></MemoryRouter></HelmetProvider>);
    expect(markup).toContain('href="/privacy"');
    expect(markup).toContain('geometry checks');
  });
});
