import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { PetProvider } from '../src/contexts/PetContext';
import PetPreviewPage from '../src/pages/PetPreviewPage';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  act(() => root.render(<MemoryRouter><HelmetProvider><PetProvider><PetPreviewPage /></PetProvider></HelmetProvider></MemoryRouter>));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('compares the original Pip clip with its new seamless transparent loop', () => {
  expect(Array.from(container.querySelectorAll('video')).map(video => video.querySelector('source:last-child')?.getAttribute('src'))).toEqual([
    '/pets/pip-idle.mp4', '/pets/loops-v2/pip-idle-alpha.webm',
  ]);
  expect(container.querySelector('h1')?.textContent).toBe('Little buddies. Smooth loops.');
  expect(container.querySelectorAll('figcaption strong')[1].textContent).toBe('Seamless + transparent');
  expect(container.querySelector('.pet-preview-stage--original .pet-avatar--transparent')).toBeNull();
  expect(container.querySelector('.pet-preview-grid--checkerboard')).not.toBeNull();
  expect(container.textContent).toContain('Pip, Nib, and Clik use seamless, transparent animations throughout the app');
});

it('changes the comparison background and records the selection', () => {
  const midnight = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Midnight')!;
  act(() => midnight.click());
  expect(midnight.getAttribute('aria-pressed')).toBe('true');
  expect(container.querySelector('.pet-preview-grid--midnight')).not.toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('pet_preview_background_selected', { background: 'midnight' });
});

it('pauses both versions together and restores still posters', () => {
  act(() => container.querySelector<HTMLButtonElement>('.pet-preview-motion')!.click());
  expect(container.querySelector('video')).toBeNull();
  expect(container.querySelectorAll('.pet-preview-grid img')).toHaveLength(2);
  expect(container.querySelector('.pet-preview-motion')?.textContent).toBe('Play');
});

it.each(['pip', 'nib', 'clik'])('compares every transparent %s animation with its matching original', pet => {
  const select = container.querySelectorAll('select');
  act(() => { select[0].value = pet; select[0].dispatchEvent(new Event('change', { bubbles: true })); });
  for (const state of ['idle', 'building', 'celebrating']) {
    act(() => { select[1].value = state; select[1].dispatchEvent(new Event('change', { bubbles: true })); });
    expect(Array.from(container.querySelectorAll('video')).map(video => video.querySelector('source:last-child')?.getAttribute('src'))).toEqual([
      `/pets/${pet}-${state}.mp4`, `/pets/loops-v2/${pet}-${state}-alpha.webm`,
    ]);
    expect(posthog.capture).toHaveBeenCalledWith('pet_preview_animation_selected', { pet_id: pet, state });
  }
});
