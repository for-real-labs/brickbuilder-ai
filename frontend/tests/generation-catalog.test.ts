import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { sampleCatalogParts, decodePackedPart, type CatalogPart } from '../src/utils/generationCatalog';

const catalog: CatalogPart[] = JSON.parse(readFileSync('public/assets/generation-parts/catalog.json', 'utf8'));
it('offers the full renderable catalog with a packed asset for each part', () => {
  expect(catalog.length).toBeGreaterThan(1500);
  for (const part of catalog) {
    expect(existsSync(`public/assets/generation-parts/${part.id}.mpd.gz`)).toBe(true);
    expect(part.colors.length).toBeGreaterThan(0);
  }
  for (const name of ['Wheel', 'Slope', 'Technic', 'Hinge']) expect(catalog.some(part => part.name.includes(name))).toBe(true);
});
it('samples distinct parts and their available colors without changing the catalog', () => {
  const parts = sampleCatalogParts(catalog, 30, () => 0.5);
  expect(parts).toHaveLength(30);
  expect(new Set(parts.map(part => part.id)).size).toBe(30);
  for (const part of parts) expect(catalog.find(entry => entry.id === part.id)?.colors).toContain(part.color);
  expect(sampleCatalogParts([], 30)).toEqual([]);
});
it.each(['Wheel', 'Slope', 'Technic', 'Hinge'])('loads packed %s geometry without external dependencies', async name => {
  const part = catalog.find(part => part.name.includes(name))!;
  const source = gunzipSync(readFileSync(`public/assets/generation-parts/${part.id}.mpd.gz`)).toString();
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  const group = await new Promise<import('three').Group>((resolve, reject) => loader.parse(source, resolve, reject));
  let meshes = 0;
  group.traverse(object => { if (object.type === 'Mesh') meshes++; });
  expect(meshes).toBeGreaterThan(0);
});

it('accepts both gzipped bytes and browser-decompressed responses', () => {
  const bytes = readFileSync('public/assets/generation-parts/3001.mpd.gz');
  expect(decodePackedPart(bytes)).toBe(gunzipSync(bytes).toString());
  expect(decodePackedPart(gunzipSync(bytes))).toBe(gunzipSync(bytes).toString());
});
