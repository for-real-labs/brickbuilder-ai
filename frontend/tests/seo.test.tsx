import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelmetProvider, type HelmetServerState } from 'react-helmet-async';
import { afterEach, describe, expect, it } from 'vitest';
import { SEO } from '../src/components/SEO';

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('SEO metadata ownership', () => {
  it('replaces the static homepage defaults and updates one canonical during navigation', () => {
    const shell = new DOMParser().parseFromString(readFileSync('index.html', 'utf8'), 'text/html');
    document.head.innerHTML = shell.head.innerHTML;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    for (const [path, noIndex] of [['/blog', false], ['/order', true], ['/glb-to-lego', false], ['/', false]] as const) {
      const url = `https://brickbuilder.ai${path}`;
      act(() => root!.render(<HelmetProvider><SEO title={path === '/' ? undefined : path} url={url} noIndex={noIndex} /></HelmetProvider>));
      const title = path === '/' ? 'Free AI LEGO-compatible Model Maker | BrickBuilder AI' : path;
      expect(document.title).toBe(title);
      for (const selector of ['meta[name="title"]', 'meta[property="og:title"]', 'meta[name="twitter:title"]']) {
        expect(document.head.querySelectorAll(selector)).toHaveLength(1);
        expect(document.head.querySelector(selector)?.getAttribute('content')).toBe(title);
      }
      if (path === '/') {
        for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) {
          expect(document.head.querySelector(selector)?.getAttribute('content')).toBe(shell.head.querySelector(selector)?.getAttribute('content'));
        }
      }
      expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
      expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toBe(url);
      expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
      expect(document.head.querySelectorAll('meta[name="robots"]')).toHaveLength(1);
      expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(noIndex ? 'noindex, nofollow' : 'index, follow');
      const scripts = document.head.querySelectorAll('script[type="application/ld+json"]');
      expect(scripts).toHaveLength(1);
      expect(JSON.parse(scripts[0].textContent!).url).toBe(url);
      expect(JSON.parse(scripts[0].textContent!)).not.toHaveProperty('softwareVersion');
    }
  });

  it('escapes structured-data HTML delimiters while preserving its JSON value', () => {
    const context: { helmet?: HelmetServerState } = {};
    const canUseDOM = HelmetProvider.canUseDOM;
    HelmetProvider.canUseDOM = false;
    const headline = '</script><script>alert("test")</script>';
    try {
      renderToStaticMarkup(<HelmetProvider context={context}><SEO structuredData={{ headline }} /></HelmetProvider>);
    } finally {
      HelmetProvider.canUseDOM = canUseDOM;
    }
    const parsed = new DOMParser().parseFromString(context.helmet!.script.toString(), 'text/html');
    expect(parsed.querySelectorAll('script')).toHaveLength(1);
    expect(JSON.parse(parsed.querySelector('script')!.textContent!).headline).toBe(headline);
  });
});

it('omits demo and early-access positioning from preview and access-screen copy', () => {
  expect(readFileSync('index.html', 'utf8')).not.toMatch(/experimental|results may vary|beta 1\.0/i);
  expect(readFileSync('src/components/ProtectedRoute.tsx', 'utf8')).not.toMatch(/BrickBuilder Demo|early access/i);
  expect(readFileSync('public/og-preview.html', 'utf8')).not.toMatch(/\.beta|experimental|results may vary/i);
});
