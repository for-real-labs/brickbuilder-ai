import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/examples/jsm/materials/LDrawConditionalLineMaterial.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LDRAW_GENERATION_SCENES, LdrawGenerationAnimation } from '../src/components/LdrawGenerationAnimation';

vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ modelPath, generationDrops, interactionEnabled, presentation, autoRotate }: {
  modelPath: string; generationDrops: boolean; interactionEnabled: boolean; presentation: string; autoRotate: boolean;
}) => <div data-testid="viewer" data-path={modelPath} data-interactive={interactionEnabled}
  data-presentation={presentation} data-animated={generationDrops} data-rotating={autoRotate} /> }));

const catalog = readFileSync('../backend/src/data/brickwith_parts.csv', 'utf8');
const available = new Set(catalog.split(/\r?\n/).slice(1).map(line => {
  const [part, color] = line.split(',');
  return `${part?.toLowerCase()}:${color}`;
}));

const brickSizes: Record<string, { studsX: number; studsZ: number; height: number }> = {
  '3001': { studsX: 4, studsZ: 2, height: 24 },
  '3003': { studsX: 2, studsZ: 2, height: 24 },
  '3005': { studsX: 1, studsZ: 1, height: 24 },
  '3020': { studsX: 4, studsZ: 2, height: 8 },
  '3034': { studsX: 8, studsZ: 2, height: 8 },
};

function placement(line: string) {
  const fields = line.trim().split(/\s+/);
  const part = fields[14].replace(/\.dat$/i, '');
  const dimensions = brickSizes[part];
  expect(dimensions).toBeDefined();
  expect(fields.slice(5, 14).map(Number)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  return { x: Number(fields[2]), y: Number(fields[3]), z: Number(fields[4]), ...dimensions };
}

function studs(center: number, count: number) {
  return Array.from({ length: count }, (_, index) => center + (index - (count - 1) / 2) * 20);
}

function sharesStud(first: ReturnType<typeof placement>, second: ReturnType<typeof placement>) {
  return studs(first.x, first.studsX).some(x => studs(second.x, second.studsX).includes(x))
    && studs(first.z, first.studsZ).some(z => studs(second.z, second.studsZ).includes(z));
}

function bodiesOverlap(first: ReturnType<typeof placement>, second: ReturnType<typeof placement>) {
  const axisOverlap = (a: number, aSize: number, b: number, bSize: number) => Math.abs(a - b) * 2 < aSize + bSize;
  return axisOverlap(first.x, first.studsX * 20, second.x, second.studsX * 20)
    && axisOverlap(first.z, first.studsZ * 20, second.z, second.studsZ * 20)
    && first.y < second.y + second.height && second.y < first.y + first.height;
}

it.each(LDRAW_GENERATION_SCENES)('packs the %s scene with renderable LDraw parts sold by Brickwith', async scene => {
  const source = readFileSync(`scripts/ldraw-generation-scenes/${scene}.ldr`, 'utf8');
  const placed = source.split(/\r?\n/).filter(line => line.startsWith('1 '));
  expect(placed.length).toBeGreaterThan(5);
  for (const line of placed) {
    const fields = line.trim().split(/\s+/);
    expect(available.has(`${fields[14].replace(/\.dat$/i, '').toLowerCase()}:${fields[1]}`)).toBe(true);
  }
  const packed = readFileSync(`public/assets/ldraw-generation-scenes/${scene}.mpd`, 'utf8');
  expect(packed).toContain(`0 FILE ${scene}.ldr`);
  const packedPlacements = packed.split('\n0 FILE parts/')[0].split(/\r?\n/)
    .filter(line => line.startsWith('1 ')).map(line => line.replace(' parts/', ' '));
  expect(packedPlacements).toEqual(placed);
  const build = placed.map(placement);
  build.forEach((part, index) => {
    expect(build.slice(0, index).some(previous => bodiesOverlap(part, previous))).toBe(false);
    if (index > 0) expect(build.slice(0, index).some(previous =>
      part.y + part.height === previous.y && sharesStud(part, previous))).toBe(true);
  });
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  const model = await new Promise<import('three').Group>((resolve, reject) => loader.parse(packed, resolve, reject));
  expect(model.children).toHaveLength(placed.length);
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps the falling-piece viewer mounted and locks user interaction while auto-rotating', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<LdrawGenerationAnimation />));
  const viewer = () => container.querySelector<HTMLElement>('[data-testid="viewer"]')!;
  expect(viewer().dataset.path).toBe('/assets/ldraw-generation-scenes/house.mpd');
  expect(viewer().dataset.interactive).toBe('false');
  expect(viewer().dataset.presentation).toBe('room');
  expect(viewer().dataset.animated).toBe('true');
  expect(viewer().dataset.rotating).toBe('true');
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  expect(viewer().dataset.path).toBe('/assets/ldraw-generation-scenes/house.mpd');
});

it('keeps one fully visible scene when reduced motion is preferred', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<LdrawGenerationAnimation />));
  const viewer = container.querySelector<HTMLElement>('[data-testid="viewer"]')!;
  expect(viewer.dataset.animated).toBe('false');
  expect(viewer.dataset.rotating).toBe('false');
  await act(async () => vi.advanceTimersByTimeAsync(16_000));
  expect(container.querySelector<HTMLElement>('[data-testid="viewer"]')?.dataset.path).toBe('/assets/ldraw-generation-scenes/house.mpd');
});
