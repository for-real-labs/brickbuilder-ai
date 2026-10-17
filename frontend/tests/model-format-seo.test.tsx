// @vitest-environment node
import React from 'react';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { publicPagePaths, renderPublicDocument } from '../src/public-prerender';

vi.stubGlobal('React', React);
vi.stubGlobal('localStorage', { clear() {}, getItem() { return null; }, setItem() {} });
const shell = readFileSync('index.html', 'utf8');
const config = JSON.parse(readFileSync('vercel.json', 'utf8'));

it.each(['obj', 'glb'] as const)('publishes crawlable %s conversion content, metadata, matched schema, and design links', input => {
  const output = input === 'obj' ? 'glb' : 'obj';
  const path = `/${input}-to-${output}`;
  const url = `https://brickbuilder.ai${path}`;
  expect(publicPagePaths).toContain(path);
  const doc = new JSDOM(renderPublicDocument(shell, path)).window.document;
  expect(doc.title).toContain(`${input.toUpperCase()} to ${output.toUpperCase()} Converter`);
  expect(doc.querySelector('h1')?.textContent).toBe(`${input.toUpperCase()} to ${output.toUpperCase()} Converter`);
  expect(doc.querySelectorAll('h1')).toHaveLength(1);
  expect(doc.querySelectorAll('link[rel=canonical]')).toHaveLength(1);
  expect(doc.querySelector('link[rel=canonical]')?.getAttribute('href')).toBe(url);
  expect(doc.querySelector('meta[name=robots]')?.getAttribute('content')).toBe('index, follow');
  expect(doc.querySelector('meta[name=description]')?.getAttribute('content')).toContain(`${input.toUpperCase()} to ${output.toUpperCase()}`);
  expect(doc.querySelector('meta[property="og:url"]')?.getAttribute('content')).toBe(url);
  expect(doc.querySelector('meta[name="twitter:url"]')?.getAttribute('content')).toBe(url);
  expect(doc.querySelector('input[type=file]')?.getAttribute('accept')).toBe(`.${input}`);
  for (const href of [`/${output}-to-${input}`, '/glb-to-lego', '/image-to-lego', '/?mode=all_parts']) {
    expect(doc.querySelector(`main a[href="${href}"]`)).not.toBeNull();
  }
  const schemas = JSON.parse(doc.querySelector('script[type="application/ld+json"]')!.textContent!);
  expect(schemas[0].url).toBe(url);
  expect(schemas[0].offers.price).toBe('0');
  for (const faq of schemas[1].mainEntity) {
    expect(doc.querySelector('main')?.textContent).toContain(faq.name);
    expect(doc.querySelector('main')?.textContent).toContain(faq.acceptedAnswer.text);
  }
  expect(schemas[2].itemListElement[1].item).toBe(url);
  expect(config.rewrites.slice(0, -1)).toContainEqual({ source: path, destination: `${path}.html` });
  expect(config.redirects).toContainEqual({ source: `${path}.html`, destination: path, permanent: true });
  expect(new RegExp(`^${config.rewrites.at(-1).source}$`).test(`${path}.html`)).toBe(false);
  const sitemap = new JSDOM(readFileSync('public/sitemap.xml', 'utf8'), { contentType: 'text/xml' }).window.document;
  expect(Array.from(sitemap.querySelectorAll('loc')).filter(node => node.textContent === url)).toHaveLength(1);
});

it('exposes both new converters through sitewide crawlable links', () => {
  const doc = new JSDOM(renderPublicDocument(shell, '/glb-to-lego')).window.document;
  for (const href of ['/obj-to-glb', '/glb-to-obj']) expect(doc.querySelector(`footer a[href="${href}"]`)).not.toBeNull();
});
