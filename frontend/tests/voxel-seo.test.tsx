// @vitest-environment node
import React from 'react';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';
import { renderPublicDocument } from '../src/public-prerender';
import { VOXEL_CONVERTERS, VOXEL_FORMATS } from '../src/voxelConverters';
vi.stubGlobal('React', React);
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, clear() {} });
const shell = readFileSync('index.html', 'utf8');

it.each(VOXEL_CONVERTERS)('publishes distinct useful SEO content at $path', ({ path, input, output }) => {
  const document = new JSDOM(renderPublicDocument(shell, path)).window.document;
  const title = `${input.toUpperCase()} to ${VOXEL_FORMATS[output].name} Converter`;
  expect(document.title).toContain(title);
  expect(document.querySelector('h1')?.textContent).toBe(title);
  expect(document.querySelectorAll('h1')).toHaveLength(1);
  expect(document.querySelector('link[rel=canonical]')?.getAttribute('href')).toBe(`https://brickbuilder.ai${path}`);
  expect(document.querySelector('main')?.textContent).toContain(VOXEL_FORMATS[output].limitation);
  expect(document.querySelector('input[type=file]')?.getAttribute('accept')).toBe(`.${input}`);
  const schemas = JSON.parse(document.querySelector('script[type="application/ld+json"]')!.textContent!);
  expect(schemas[0].name).toBe(title);
  expect(schemas[0].offers).toBeUndefined();
  for (const question of schemas[1].mainEntity) {
    expect(document.querySelector('main')?.textContent).toContain(question.name);
    expect(document.querySelector('main')?.textContent).toContain(question.acceptedAnswer.text);
  }
  for (const other of VOXEL_CONVERTERS.filter(converter => converter.path !== path)) {
    expect(document.querySelector(`main a[href="${other.path}"]`)).not.toBeNull();
  }
});

it.each(['/obj-to-glb', '/glb-to-obj', '/glb-to-lego', ...VOXEL_CONVERTERS.map(({ path }) => path)])('promotes LEGO design from objects, images, and text at %s', path => {
  const document = new JSDOM(renderPublicDocument(shell, path)).window.document;
  const callout = document.querySelector('aside[aria-label="Design LEGO models"]')!;
  expect(callout).not.toBeNull();
  for (const target of ['/glb-to-lego', '/image-to-lego', '/#landing-build-prompt']) expect(callout.querySelector(`a[href="${target}"]`)).not.toBeNull();
});


it.each(['/image-to-lego', '/photo-to-lego'])('keeps image landing pages focused on the build dialogue at %s', path => {
  const document = new JSDOM(renderPublicDocument(shell, path)).window.document;
  expect(document.querySelector('aside[aria-label="Design LEGO models"]')).toBeNull();
  expect(document.querySelector('[aria-label="Build suggestions"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Build dialogue"] input[type="file"]')).not.toBeNull();
});
