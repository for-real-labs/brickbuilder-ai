// @vitest-environment node
import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { IMAGE_LANDING_PAGES } from '../src/imageLandingPages';
import { imageLandingPaths, renderImageLandingDocument } from '../src/legal-prerender';

vi.stubGlobal('React', React);
vi.stubGlobal('localStorage', { clear() {}, getItem() { return null; }, setItem() {} });

describe('image landing SEO', () => {
  it.each(imageLandingPaths)('pre-renders content and unique metadata for /%s', path => {
    const document = renderImageLandingDocument(readFileSync('index.html', 'utf8'), path);
    expect(document).toContain(`<title>${IMAGE_LANDING_PAGES[path].title.replace(/&/g, "&amp;")}</title>`);
    expect(document).toContain(`content="https://brickbuilder.ai/${path}"`);
    expect(document).toContain(`href="https://brickbuilder.ai/${path}"`);
    expect(document).toContain('content="index, follow"');
    expect(document).toContain(IMAGE_LANDING_PAGES[path].uploadTitle);
    expect(document).toContain('How It Works');
    expect(document).toContain('Build It In Real Life');
    expect(document).toContain(path === 'use-ai-to-edit-ldraw' ? 'Upload LDraw model' : 'add optional instructions');
    expect(document).toContain('application/ld+json');
    expect(document).not.toContain('aggregateRating');
    expect(document).toContain(`\"url\":\"https://brickbuilder.ai/${path}\"`);
    expect(readFileSync('public/sitemap.xml', 'utf8')).toContain(`<loc>https://brickbuilder.ai/${path}</loc>`);
    const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
    expect(config.rewrites).toContainEqual({ source: `/${path}`, destination: `/${path}.html` });
  });
});
