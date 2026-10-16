import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Link } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { PetProvider, usePet, usePetActivity } from '../src/contexts/PetContext';
import { PetAvatar, PetCompanion, PetPromptGreeting } from '../src/components/PetCompanion';
import { PET_MOTION_KEY, PET_STORAGE_KEY, isPetId, petVideoPath } from '../src/pets';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

function Probe({ busy = false, completed = false, failed = false }) {
  const { pet, activity } = usePet();
  usePetActivity(busy, completed, failed);
  return <output>{pet.id}:{activity}</output>;
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const render = (children: React.ReactNode) => act(() => root.render(<MemoryRouter><PetProvider>{children}</PetProvider></MemoryRouter>));
const click = (selector: string) => act(() => (container.querySelector(selector) as HTMLButtonElement).click());

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('build buddies', () => {
  it('validates stored identities and maps listening to the lightweight idle clip', () => {
    expect(isPetId('nib')).toBe(true);
    expect(isPetId('../../anything')).toBe(false);
    expect(petVideoPath('clik', 'listening')).toBe('/pets/clik-idle.mp4');
    localStorage.setItem(PET_STORAGE_KEY, '../../anything');
    render(<Probe />);
    expect(container.querySelector('output')?.textContent).toBe('pip:idle');
  });

  it('switches the pet across surfaces, persists it and tracks the choice without submitting a form', () => {
    const submit = vi.fn();
    render(<><Probe /><form onSubmit={submit}><PetPromptGreeting /><textarea /></form><PetCompanion /></>);
    click('[aria-label="Change pet, currently Pip"]');
    expect(container.querySelector('dialog')?.open).toBe(true);
    click('[aria-label="Choose Nib"]');
    expect(submit).not.toHaveBeenCalled();
    expect(container.querySelector('output')?.textContent).toBe('nib:idle');
    expect(container.textContent).toContain('Hi, I’m Nib!');
    expect(localStorage.getItem(PET_STORAGE_KEY)).toBe('nib');
    expect(container.querySelector('dialog')).toBeNull();
    expect(posthog.capture).toHaveBeenCalledWith('pet_selected', { pet_id: 'nib', previous_pet_id: 'pip', source: 'build_prompt' });
  });

  it('restores the chosen pet on reload and responds to cross-tab selection changes', () => {
    localStorage.setItem(PET_STORAGE_KEY, 'clik');
    render(<Probe />);
    expect(container.querySelector('output')?.textContent).toBe('clik:idle');
    act(() => {
      localStorage.setItem(PET_STORAGE_KEY, 'nib');
      window.dispatchEvent(new StorageEvent('storage', { key: PET_STORAGE_KEY }));
    });
    expect(container.querySelector('output')?.textContent).toBe('nib:idle');
  });

  it('continues working when localStorage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<><Probe /><PetCompanion /></>);
    click('[aria-label="Pip, your build buddy. Change pet"]');
    click('[aria-label="Choose Clik"]');
    expect(container.querySelector('output')?.textContent).toBe('clik:idle');
  });

  it('pauses motion persistently and dismisses the accessible picker with Escape', () => {
    render(<><PetAvatar /><PetCompanion /></>);
    expect(container.querySelector('video')).not.toBeNull();
    click('[aria-label="Pip, your build buddy. Change pet"]');
    click('.pet-picker-footer button');
    expect(localStorage.getItem(PET_MOTION_KEY)).toBe('paused');
    expect(container.querySelector('video')).toBeNull();
    expect(posthog.capture).toHaveBeenCalledWith('pet_motion_changed', { enabled: false });
    act(() => container.querySelector('dialog')?.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('labels the picker and current choice, then returns keyboard focus to the conversation', () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length; });
    render(<><PetPromptGreeting mode="edit" /><PetCompanion /></>);
    const opener = container.querySelector<HTMLButtonElement>('[aria-label="Change pet, currently Pip"]')!;
    opener.focus();
    click('[aria-label="Change pet, currently Pip"]');
    const dialog = container.querySelector('dialog')!;
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector(`#${dialog.getAttribute('aria-labelledby')}`)?.textContent).toBe('Choose your build buddy');
    expect(container.querySelector(`#${dialog.getAttribute('aria-describedby')}`)?.textContent).toContain('Switch any time');
    expect(container.querySelector('[aria-label="Choose Pip"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('[aria-label="Choose Nib"]')?.getAttribute('aria-pressed')).toBe('false');
    click('[aria-label="Close pet picker"]');
    act(() => frames.forEach(callback => callback(0)));
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(opener);
  });

  it('uses still artwork for reduced motion and falls back to it on video errors', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    render(<PetAvatar />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/pets/pip.webp');
  });

  it('falls back to a poster if the clip fails to load', () => {
    render(<PetAvatar />);
    act(() => container.querySelector('video')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('uses transparency for only Pip idle/listening and hides the still poster after playback starts', () => {
    expect(petVideoPath('pip', 'idle')).toBe('/pets/pip-idle-alpha.webm');
    expect(petVideoPath('pip', 'listening')).toBe('/pets/pip-idle-alpha.webm');
    expect(petVideoPath('pip', 'building')).toBe('/pets/pip-building.mp4');
    expect(petVideoPath('pip', 'celebrating')).toBe('/pets/pip-celebrating.mp4');
    expect(petVideoPath('nib', 'idle')).toBe('/pets/nib-idle.mp4');
    render(<PetAvatar />);
    expect(container.querySelector('.pet-avatar--transparent')).not.toBeNull();
    expect(container.querySelector('.pet-avatar--alpha-playing')).toBeNull();
    act(() => container.querySelector('video')?.dispatchEvent(new Event('playing')));
    expect(container.querySelector('.pet-avatar--alpha-playing')).not.toBeNull();
    act(() => container.querySelector('video')?.dispatchEvent(new Event('error')));
    expect(container.querySelector('.pet-avatar--alpha-playing')).toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('celebrates a successful build, then returns to idle; failures do not celebrate', () => {
    vi.useFakeTimers();
    try {
      render(<Probe busy />);
      expect(container.querySelector('output')?.textContent).toBe('pip:building');
      render(<Probe completed />);
      expect(container.querySelector('output')?.textContent).toBe('pip:celebrating');
      act(() => vi.advanceTimersByTime(5000));
      expect(container.querySelector('output')?.textContent).toBe('pip:idle');
      render(<Probe busy />);
      render(<Probe completed failed />);
      expect(container.querySelector('output')?.textContent).toBe('pip:idle');
    } finally { vi.useRealTimers(); }
  });

  it('keeps the companion available after client navigation, above mobile purchase controls', () => {
    render(<><Link to="/generated-model">Open model</Link><PetCompanion /></>);
    expect(container.querySelector('.pet-dock')).not.toBeNull();
    click('a');
    expect(container.querySelector('.pet-dock--purchase')).not.toBeNull();
  });

  it('uses the selected pet in edit conversations', () => {
    localStorage.setItem(PET_STORAGE_KEY, 'clik');
    render(<PetPromptGreeting mode="edit" state="building" />);
    expect(container.textContent).toContain('Clik · your build buddy');
    expect(container.textContent).toContain('On it! I’m working on your changes.');
    expect(container.querySelector('[data-pet="clik"]')).not.toBeNull();
  });
});
