import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { LandingCreateInput } from '../src/components/LandingCreateInput';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let props: React.ComponentProps<typeof LandingCreateInput>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  props = { prompt: '', onChange: vi.fn(), onFocus: vi.fn(), onBlur: vi.fn(), inputRef: createRef(), previewUrl: null,
    generationSettings: { open: false, controls: 'settings', onOpen: vi.fn() }, onPick: vi.fn(), onRemove: vi.fn(), onRandom: vi.fn(), busy: false, submitDisabled: false, random: false };
  vi.mocked(posthog.capture).mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('expands on focus without replacing the focused input and stays expanded after blur', () => {
  act(() => root.render(<LandingCreateInput {...props} />));
  const input = host.querySelector('input')!;
  expect(host.querySelector('.landing-upload-prompt--text-first')).toBeNull();
  act(() => input.focus());
  expect(host.querySelector('.landing-upload-prompt--text-first')).not.toBeNull();
  expect(host.querySelector('input')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(host.querySelector('.landing-upload-target')?.textContent).toBe('Upload image');
  expect(props.onFocus).toHaveBeenCalledOnce();
  act(() => input.blur()); act(() => input.focus());
  expect(posthog.capture).toHaveBeenCalledExactlyOnceWith('landing_text_entry_expanded');
  act(() => host.querySelector<HTMLButtonElement>('.landing-upload-target')!.click());
  expect(props.onPick).toHaveBeenCalledOnce();
});
it('starts text-first for a restored prompt and preserves image removal', () => {
  act(() => root.render(<LandingCreateInput {...props} prompt="A castle" previewUrl="blob:preview" fileName="castle.png" />));
  expect(host.querySelector('.landing-upload-prompt--text-first')).not.toBeNull();
  expect(host.querySelector('input')?.value).toBe('A castle');
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove image"]')!.click());
  expect(props.onRemove).toHaveBeenCalledOnce();
});
it('respects reduced motion when expanding', () => {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
  act(() => root.render(<LandingCreateInput {...props} />));
  const card = host.querySelector<HTMLElement>('.landing-upload-prompt')!;
  card.animate = vi.fn();
  act(() => host.querySelector('input')!.focus());
  expect(card.animate).not.toHaveBeenCalled();
  expect(card.classList.contains('landing-upload-prompt--text-first')).toBe(true);
});

it('opens settings from the gear without submitting, including with a random idea', () => {
  const submit = vi.fn(event => event.preventDefault());
  act(() => root.render(<form onSubmit={submit}><LandingCreateInput {...props} random /></form>));
  const gear = host.querySelector<HTMLButtonElement>('[aria-label="Generation settings"]')!;
  expect(gear.previousElementSibling?.getAttribute('aria-label')).toBe('Generate');
  expect(gear.getAttribute('aria-controls')).toBe('settings');
  expect(gear.getAttribute('aria-expanded')).toBe('false');
  act(() => gear.click());
  expect(props.generationSettings.onOpen).toHaveBeenCalledWith(gear);
  expect(submit).not.toHaveBeenCalled();
  expect(posthog.capture).toHaveBeenCalledWith('landing_generation_settings_clicked', { source: 'generate_button' });
});
