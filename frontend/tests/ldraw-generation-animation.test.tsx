import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { createRoot } from 'react-dom/client';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/examples/jsm/materials/LDrawConditionalLineMaterial.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LDRAW_GENERATION_SCENES, LdrawGenerationAnimation } from '../src/components/LdrawGenerationAnimation';

vi.mock('../src/components/ThreeLDRViewer', () => ({ ThreeLDRViewer: ({ modelPath, buildAnimationStyle, presentation, animateModelBuild }: {
  modelPath: string; buildAnimationStyle: string; presentation: string; animateModelBuild: boolean;
}) => <div data-testid="viewer" data-path={modelPath} data-style={buildAnimationStyle}
  data-presentation={presentation} data-animated={animateModelBuild} /> }));

const catalog = readFileSync('../backend/src/data/brickwith_parts.csv', 'utf8');
const available = new Set(catalog.split(/\r?\n/).slice(1).map(line => {
  const [part, color] = line.split(',');
  return `${part?.toLowerCase()}:${color}`;
}));

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

it('cycles packed 3D scenes without repeating the current scene', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<LdrawGenerationAnimation />));
  const viewer = () => container.querySelector<HTMLElement>('[data-testid="viewer"]')!;
  expect(viewer().dataset.path).toBe('/assets/ldraw-generation-scenes/house.mpd');
  expect(viewer().dataset.style).toBe('fade');
  expect(viewer().dataset.presentation).toBe('model');
  await act(async () => vi.advanceTimersByTimeAsync(8_000));
  expect(viewer().dataset.path).toBe('/assets/ldraw-generation-scenes/tree.mpd');
});

it('keeps one fully visible scene when reduced motion is preferred', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  await act(async () => root.render(<LdrawGenerationAnimation />));
  const viewer = container.querySelector<HTMLElement>('[data-testid="viewer"]')!;
  expect(viewer.dataset.animated).toBe('false');
  await act(async () => vi.advanceTimersByTimeAsync(16_000));
  expect(container.querySelector<HTMLElement>('[data-testid="viewer"]')?.dataset.path).toBe('/assets/ldraw-generation-scenes/house.mpd');
});
