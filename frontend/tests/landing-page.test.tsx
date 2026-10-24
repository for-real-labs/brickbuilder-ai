import { readFileSync } from 'node:fs';
import { getGuestSession } from '../src/utils/guestSession';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js', () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');

  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

const billingSettings = vi.hoisted(() => ({ enabled: false, account: null, loading: false, getFeatureAccess: () => 'allowed', openUpgrade: vi.fn() }));
vi.mock('../src/contexts/BillingContext', () => ({ useBilling: () => billingSettings }));

const authSettings = vi.hoisted(() => ({ isSupabaseConfigured: false, user: null as { id: string } | null }));

vi.mock('../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: null,
    loading: false,
    user: authSettings.user,
    isSupabaseConfigured: authSettings.isSupabaseConfigured,
  }),
}));

vi.mock('../src/components/SEO', () => ({
  SEO: () => null,
}));

vi.mock('../src/components/FallingBricks', () => ({
  default: () => null,
}));

vi.mock('../src/components/LoginModal', () => ({
  default: () => null,
}));

vi.mock('../src/components/StreamingMeshViewer', () => ({
  default: () => null,
}));

vi.mock('../src/components/SiteFooter', () => ({
  SiteFooter: () => <footer>Site footer</footer>,
}));

vi.mock('../src/components/GlbUploadCard', () => ({
  GlbUploadCard: () => null,
}));

vi.mock('../src/components/ProfileMenu', () => ({
  ProfileMenu: () => null,
}));

import LandingPage, { DEFAULT_GENERATION_METHOD, GenerationModelSelector } from '../src/pages/LandingPage';
import { DEFAULT_LLM_MODEL } from '../src/services/llmToBricksApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';
import { GetGenerationStatsApiService } from '../src/services/getGenerationStatsApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { GetCommunityGenerationsApiService } from '../src/services/getCommunityGenerationsApi';
import { NovaToBricksApiService, DEFAULT_NOVA_OPTIONS } from '../src/services/novaToBricksApi';
import { LocalProvidersApiService, type LocalProviderStatus } from '../src/services/localProvidersApi';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { PetProvider } from '../src/contexts/PetContext';
import { PetCompanion } from '../src/components/PetCompanion';
import { BuildBuddyApi } from '../src/services/buildBuddyApi';

beforeEach(() => {
  billingSettings.enabled = false;
  authSettings.user = null;
  vi.spyOn(BuildBuddyApi, 'classify').mockResolvedValue({ intent: 'generate', confidence: 1 });
});

const connectedProvider = (id: LocalProviderStatus['id']): LocalProviderStatus => ({
  id, label: id, api_key_configured: false, cli_available: true, cli_connected: true,
  login: { status: 'connected' }, capabilities: ['browser_login'],
});

describe('LandingPage', () => {
  it('keeps build buddy switching in Tools and out of generation settings without submitting', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 0 }) } as Response);
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

    const generate = vi.spyOn(LlmToBricksApiService, 'generate');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: vi.fn(function (this: HTMLDialogElement) { this.open = true; }) });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter><PetProvider><LandingPage /><PetCompanion /></PetProvider></MemoryRouter>));
      expect(container.querySelector('.pet-greeting [aria-label^="Change Build Buddy"]')).toBeNull();
      expect(container.querySelector('.landing-random-idea')?.textContent).toContain('Try something random');
      const panel = container.querySelector<HTMLDivElement>('#landing-generation-settings')!;
      const tools = container.querySelector<HTMLButtonElement>('header nav button[aria-controls]')!;
      act(() => tools.click());
      act(() => container.querySelector<HTMLButtonElement>('ul[aria-label="Tools"] [aria-label="Generation settings"]')!.click());
      expect(panel.hidden).toBe(false);
      expect(panel.querySelector('[aria-label^="Change Build Buddy"]')).toBeNull();
      act(() => tools.click());
      const switchPet = container.querySelector<HTMLButtonElement>('ul[aria-label="Tools"] [aria-label="Change Build Buddy, currently Pip"]')!;
      expect(switchPet.type).toBe('button');
      expect(switchPet.textContent).toBe('Build Buddy');
      expect(switchPet.querySelector('.lucide-paw-print')).not.toBeNull();
      expect(container.querySelector('ul[aria-label="Tools"] [aria-label="Generation settings"]')?.textContent).toBe('Generation settings');
      expect(switchPet.closest('li')?.previousElementSibling?.getAttribute('role')).toBe('separator');
      act(() => { switchPet.focus(); switchPet.click(); });
      expect(tools.getAttribute('aria-expanded')).toBe('false');
      expect(container.querySelector('dialog')?.open).toBe(true);
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Choose Clik"]')!.click());
      expect(container.querySelector('.pet-greeting')?.textContent).toMatch(/brick building buddy|recent builds/);
      expect(container.querySelector('.pet-greeting [data-pet="clik"]')).not.toBeNull();
      expect(panel.querySelector('[aria-label^="Change Build Buddy"]')).toBeNull();
      expect(container.querySelector('dialog')).toBeNull();
      act(() => tools.click());
      expect(container.querySelector('ul[aria-label="Tools"] [aria-label="Change Build Buddy, currently Clik"]')).not.toBeNull();
      expect(generate).not.toHaveBeenCalled();
      const capture = (await import('posthog-js')).default.capture;
      expect(capture).toHaveBeenCalledWith('pet_picker_opened', { source: 'landing_tools' });
      expect(capture).toHaveBeenCalledWith('pet_selected', { pet_id: 'clik', previous_pet_id: 'pip', source: 'landing_tools' });
    } finally { act(() => root.unmount()); container.remove(); }
  });

  it.each([
    { saved: undefined, expected: 'nova' },
    { saved: 'unknown', expected: 'nova' },
    { saved: 'nova', expected: 'nova' },
    { saved: 'llm', expected: 'llm' },
    { saved: '3d', expected: 'nova' },
  ])('restores saved mode $saved as $expected after login', async ({ saved, expected }) => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

    sessionStorage.setItem('pendingLandingState', JSON.stringify({ prompt: 'A red castle', generationMethod: saved }));
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const mode = container.querySelector('#landing-builder-mode')!;
      expect(mode.querySelector(`button[value="${expected === '3d' ? 'llm' : expected}"]`)?.getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('#all-parts-warning')).toBeNull();
      expect((container.querySelector('#landing-render-model') as HTMLSelectElement).value).toBe(expected === '3d' ? 'sam3d' : DEFAULT_LLM_MODEL);
      expect((container.querySelector('[aria-label="Describe your model"]') as HTMLInputElement).value).toBe('A red castle');
      expect(sessionStorage.getItem('pendingLandingState')).toBeNull();
    } finally {
      act(() => root.unmount());
      sessionStorage.removeItem('pendingLandingState');
    }
  });

  it('honors the all-parts image handoff when restoring an older basic-bricks draft', async () => {
    window.history.replaceState({}, '', '/image-to-lego?mode=all_parts');
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

    sessionStorage.setItem('pendingLandingState', JSON.stringify({ generationMethod: 'llm', prompt: 'Castle' }));
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage imageLandingPath="image-to-lego" />));
      expect(container.querySelector('button[value="nova"]')?.getAttribute('aria-pressed')).toBe('true');
    } finally {
      act(() => root.unmount());
      sessionStorage.removeItem('pendingLandingState');
      window.history.replaceState({}, '', '/');
    }
  });

  it.each(['gpt-6.1-sol', 'gpt-6-astra', 'claude-opus-5-5', 'claude-opus-5', 'gpt-5.5', 'sam3d', 'trellis'])('restores saved model %s to the Opus default and submits it', async savedModel => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

    const generate = vi.spyOn(LlmToBricksApiService, 'generate').mockRejectedValue(new Error('Test basic request'));
    sessionStorage.setItem('pendingLandingState', JSON.stringify({ prompt: 'Blue car', generationMethod: 'llm', llmModel: savedModel }));
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const model = container.querySelector('#landing-render-model') as HTMLSelectElement;
      expect(Array.from(model.options).map(option => ({ value: option.value, label: option.label }))).toEqual([
        { value: DEFAULT_LLM_MODEL, label: 'Claude Opus 5.5' },
        { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
      ]);
      expect(model.value).toBe(DEFAULT_LLM_MODEL);
      const create = container.querySelector<HTMLButtonElement>('button[type="submit"][aria-label="Create"], button[type="submit"][aria-label="Generate"]')!;
      await act(async () => create.click());
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_LLM_MODEL }), undefined);
    } finally { act(() => root.unmount()); sessionStorage.removeItem('pendingLandingState'); container.remove(); }
  });

  it.each(['accepted', 'failed', 'daily limit'])('submits an image with Enter and clears it only when %s', async outcome => {
    vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });

    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const BrowserURL = URL;
    vi.stubGlobal('URL', class extends BrowserURL {
      static createObjectURL = vi.fn(() => 'blob:uploaded-image');
      static revokeObjectURL = vi.fn();
    });
    const limitMessage = 'You have reached the daily limit of 30 generations. Please wait until October 21, 2026 at 7:00 PM CDT to generate again.';
    let accept!: (response: { generation_id: string; message: string }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ generation_id: string; message: string }>((resolve, fail) => {
      accept = resolve;
      reject = fail;
    });
    const start = vi.spyOn(LlmToBricksApiService, 'generate')
      .mockImplementationOnce(() => pending)
      .mockResolvedValue({ generation_id: 'next', message: 'Started' });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      act(() => container.querySelector<HTMLButtonElement>('#landing-builder-mode button[value="llm"]')!.click());
      const prompt = container.querySelector('[aria-label="Describe your model"]') as HTMLInputElement;
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(prompt, 'Anime girl');
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['image'], 'girl.png', { type: 'image/png' })] });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.querySelector('[alt="Uploaded preview"]')).toBeTruthy();
      await act(async () => {
        prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
      });
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Anime girl', imageBase64: expect.any(String) }), undefined);
      expect(container.querySelector('[alt="Uploaded preview"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Describe your model"]')).toBeNull();
      await act(async () => {
        prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        if (outcome === 'accepted') accept({ generation_id: 'submitted', message: 'Started' });
        else reject(new Error(outcome === 'daily limit' ? limitMessage : 'Submission failed'));
      });
      if (outcome === 'accepted') {
        expect(container.querySelector('[aria-label="Build buddy conversation"]')!.textContent).not.toContain('email');
        expect(container.querySelector('[aria-label="Build progress workspace"] [aria-label="Bricks falling onto a table"]')).not.toBeNull();
        expect(container.querySelector('[alt="Uploaded preview"]')).toBeNull();
        expect(container.querySelector('[aria-label="Remove image"]')).toBeNull();
        expect(fileInput.value).toBe('');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:uploaded-image');
        act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Generation in progress actions"] button')).find(button => button.textContent === 'Start new')!.click());
        expect(container.querySelector('.pet-dialogue')?.textContent).toMatch(/brick building buddy|recent builds/);
        const nextPrompt = container.querySelector('input[aria-label="Describe your model"]') as HTMLInputElement;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nextPrompt, 'Anime girl');
          nextPrompt.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => nextPrompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Anime girl', imageBase64: undefined }), undefined);
      } else {
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(container.querySelector('[alt="Uploaded preview"]')).toBeTruthy();
        const dialogue = container.querySelector('[aria-label="Build buddy conversation"]')!;
        expect(dialogue.querySelector('[role="status"]')?.textContent)
          .toBe(outcome === 'daily limit' ? limitMessage : 'Oops! I couldn’t make your build. Please try again.');
        expect(container.textContent?.split(outcome === 'daily limit' ? limitMessage : 'Oops! I couldn’t make your build. Please try again.')).toHaveLength(2);
        expect(container.textContent).not.toContain('Submission failed');
        expect(container.textContent).not.toContain('Generation Failed');
        expect(container.textContent).not.toContain('Try Again');
        expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      }
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', expect.objectContaining({ has_image: true, has_prompt: true }));
    } finally {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });

  it('ignores Enter during text composition or key repeats, and validates an empty Enter submission', async () => {
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });

    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const start = vi.spyOn(LlmToBricksApiService, 'generate');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const prompt = container.querySelector('[aria-label="Describe your model"]') as HTMLInputElement;
      for (const options of [{ isComposing: true }, { repeat: true }, { keyCode: 229 }]) {
        await act(async () => {
          prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options }));
        });
      }
      expect(container.querySelector('#generation-input-help')).toBeNull();
      await act(async () => {
        prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(container.querySelector('#generation-input-help')?.textContent).toContain('Describe what you’d like to build');
      expect(start).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('guides empty submissions at the input without showing a generation failure or starting AI', async () => {
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });

    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const generateAi = vi.spyOn(LlmToBricksApiService, 'generate');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const generate = container.querySelector<HTMLButtonElement>('button[type="submit"][aria-label="Create"], button[type="submit"][aria-label="Generate"]')!;
      await act(async () => generate.click());
      expect(container.querySelector('#generation-input-help')?.textContent).toContain('Describe what you’d like to build');
      expect(container.textContent).not.toContain('Generation Failed');
      expect(container.textContent).not.toContain('Try Again');
      expect(generateAi).not.toHaveBeenCalled();
      const input = container.querySelector('[aria-label="Describe your model"]') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      expect(input.getAttribute('aria-describedby')).toBe('generation-input-help');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'A red cube');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(container.querySelector('#generation-input-help')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each([undefined, 'image-to-lego', 'photo-to-lego', 'use-ai-to-edit-ldraw'] as const)('omits the lower sections and community request on %s', async path => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 0 }) } as Response);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const community = vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations');
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage imageLandingPath={path} />));
      act(() => window.dispatchEvent(new Event('scroll')));
      expect(Boolean(container.textContent?.includes('The Easiest Way to Make LEGO'))).toBe(path !== 'use-ai-to-edit-ldraw');
      expect(Boolean(container.querySelector('[aria-label="BrickBuilder generation statistics"]'))).toBe(path !== 'use-ai-to-edit-ldraw');
      if (path !== 'use-ai-to-edit-ldraw') {
        expect(container.querySelector('[aria-label="Build dialogue"]')).not.toBeNull();
        expect(container.querySelector('button[type="submit"][aria-label="Create"], button[type="submit"][aria-label="Generate"]')).not.toBeNull();
        const help = container.querySelector('.landing-page-help')!;
        expect(help.getAttribute('aria-hidden')).toBe('true');
        const socialLinks = Array.from(help.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Social links"] a'));
        expect(socialLinks.map(link => link.getAttribute('aria-label'))).toEqual(['GitHub', 'Instagram', 'YouTube', 'TikTok']);
        expect(socialLinks.every(link => link.tabIndex === -1)).toBe(true);
        const dialogue = container.querySelector('[aria-label="Build dialogue"]')!;
        act(() => dialogue.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 })));
        expect(help.getAttribute('aria-hidden')).toBe('false');
        expect(help.querySelector('a')?.getAttribute('href')).toBe('mailto:support@brickbuilder.ai');
        expect(help.querySelector('a')?.tabIndex).toBe(0);
        expect(socialLinks.every(link => link.tabIndex === 0 && link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true);
        act(() => dialogue.dispatchEvent(new Event('pointerdown', { bubbles: true })));
        expect(help.getAttribute('aria-hidden')).toBe('true');
        expect(help.querySelector('a')?.tabIndex).toBe-1;
        expect(socialLinks.every(link => link.tabIndex === -1)).toBe(true);
        expect(container.querySelector('h1')?.textContent).toBe('The Easiest Way to Make LEGO');
        expect(container.querySelector('[aria-label="Build dialogue"]')).toBe(dialogue);
      }
      expect(container.querySelector('[aria-label="Community models"]')).toBeNull();
      expect(container.querySelector('#how-it-works')).toBeNull();
      expect(container.textContent).not.toContain('Build It In Real Life');
      expect(container.querySelector('img[src*="brickworld26"]')).toBeNull();
      expect(container.querySelector('footer')).toBeNull();
      expect(community).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });

  it('starts LLM jobs in the background and allows another submission while they run', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    const start = vi.spyOn(LlmToBricksApiService, 'generate')
      .mockResolvedValueOnce({ generation_id: 'one', message: 'Started' })
      .mockResolvedValueOnce({ generation_id: 'two', message: 'Started' });
    const stream = vi.spyOn(LlmToBricksApiService, 'generateStream');
    const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete');
    const cancel = vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      act(() => container.querySelector<HTMLButtonElement>('#landing-builder-mode button[value="llm"]')!.click());
      await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"][aria-label="Create"], button[type="submit"][aria-label="Generate"]')!.click());
      expect(start).not.toHaveBeenCalled();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', expect.objectContaining({ has_prompt: false, has_image: false }));
      const input = container.querySelector('input:not([type="file"])') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Red castle');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const generate = () => container.querySelector<HTMLButtonElement>('button[type="submit"][aria-label="Create"], button[type="submit"][aria-label="Generate"]')!;
      await act(async () => generate().click());
      expect(container.querySelector('[aria-label="Build progress workspace"] [aria-label="Bricks falling onto a table"]')).not.toBeNull();
      expect(container.querySelector('#landing-build-prompt')).toBeNull();
      expect(container.querySelector('[aria-label="Generation in progress actions"]')?.textContent).toContain('Email me');
      act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Generation in progress actions"] button')).find(button => button.textContent === 'Start new')!.click());
      expect(container.querySelector('.pet-dialogue')?.textContent).toMatch(/brick building buddy|recent builds/);
      const nextInput = container.querySelector('input[aria-label="Describe your model"]') as HTMLInputElement;
      expect(nextInput.value).toBe('');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nextInput, 'Blue boat');
        nextInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => generate().click());
      expect(container.querySelector('[aria-label="Build progress workspace"] [aria-label="Bricks falling onto a table"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Your generations"]')).toBeNull();
      expect(start).toHaveBeenCalledTimes(2);
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', {
        generation_method: 'llm', model: DEFAULT_LLM_MODEL, has_prompt: true,
        has_image: false, size: 'big', is_authenticated: false, page: '/', input_type: 'text',
      });
      expect(stream).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(`pending_generations:v2:guest:${getGuestSession()}`)!).map((row: { id: string }) => row.id)).toEqual(['two', 'one']);
      await act(async () => Array.from(container.querySelectorAll('[aria-label="Generation in progress actions"] button')).find(button => button.textContent === 'Cancel')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(cancel).toHaveBeenCalledWith('two');
      expect(container.querySelector('[aria-label="Build progress workspace"]')).toBeNull();
      expect(container.querySelector('[aria-label="Build buddy conversation"]')?.textContent).not.toContain('Red castle');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each(['image-to-lego', 'photo-to-lego'] as const)('uses the shared upload and generation flow on /%s', async path => {
    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => connectedProvider(id));
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

    const nova = vi.spyOn(NovaToBricksApiService, 'generate').mockRejectedValue(new Error('Test Nova request'));
    const llm = vi.spyOn(LlmToBricksApiService, 'generate').mockRejectedValue(new Error('Test basic request'));
    const BrowserURL = URL;
    vi.stubGlobal('URL', class extends BrowserURL { static createObjectURL = vi.fn(() => 'blob:reference'); static revokeObjectURL = vi.fn(); });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage imageLandingPath={path} />));
      const upload = container.querySelector('[aria-label="Image upload"]')!;
      const prompt = container.querySelector('[aria-label="Describe your model"]') as HTMLInputElement;
      expect(upload.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(prompt.placeholder).toBe('Add optional image instructions');
      expect(container.querySelector('#how-it-works')).toBeNull();
      const picker = container.querySelector('input[type=file]') as HTMLInputElement;
      expect(picker.accept).toContain('.heic');
      const file = new File(['reference'], 'castle.png', { type: 'image/png' });
      await act(async () => {
        Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(upload.querySelector('img')?.getAttribute('src')).toBe('blob:reference');
      const create = container.querySelector<HTMLButtonElement>('button[type=submit]')!;
      await act(async () => { create.click(); await vi.waitFor(() => expect(nova).toHaveBeenCalledTimes(1)); });
      expect(nova).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: btoa('reference'), imageMediaType: 'image/png', model: DEFAULT_LLM_MODEL }), undefined);
      expect(container.querySelector('[aria-label="Build buddy conversation"] [role="status"]')?.textContent)
        .toBe('Oops! I couldn’t make your build. Please try again.');
      expect(container.textContent).not.toContain('Test Nova request');
      expect(container.textContent).not.toContain('Generation Failed');
      act(() => container.querySelector<HTMLButtonElement>('button[value="llm"]')!.click());
      await act(async () => { create.click(); await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(1)); });
      expect(llm).toHaveBeenCalledWith(expect.objectContaining({ imageBase64: btoa('reference'), model: DEFAULT_LLM_MODEL }), undefined);
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Remove image"]')!.click());
      expect(upload.querySelector('img')).toBeNull();
      const drop = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } });
      await act(async () => container.firstElementChild!.dispatchEvent(drop));
      expect(upload.querySelector('img')).toBeTruthy();
    } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
  });

  it('defaults to All parts, routes through Nova, and keeps the model when switching to Basic bricks', async () => {
    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => connectedProvider(id));
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });

    const nova = vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'full-set', message: 'Started' });
    const llm = vi.spyOn(LlmToBricksApiService, 'generate');
    const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const findButton = (text: string) => Array.from(container.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === text || button.textContent?.includes(text))!;
    try {
      await act(async () => root.render(<LandingPage />));
      const mode = container.querySelector('#landing-builder-mode') as HTMLDivElement;
      const model = container.querySelector('#landing-render-model') as HTMLSelectElement;
      expect(mode.querySelector('button[value="nova"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(mode.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('false');
      expect(Array.from(mode.querySelectorAll('button')).map(button => button.textContent)).toEqual(['Basic bricks', 'All parts']);
      expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(model.value).toBe(DEFAULT_LLM_MODEL);
      expect(container.querySelector('#all-parts-warning')).toBeNull();
      expect(mode.hasAttribute('aria-describedby')).toBe(false);
      const input = container.querySelector('input[aria-label="Describe your model"]') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Spaceport with launch tower, rover, and research lab');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => findButton('Generate').click());
      expect(nova).toHaveBeenCalledWith(expect.objectContaining({ ...DEFAULT_NOVA_OPTIONS, authMode: 'native', model: DEFAULT_LLM_MODEL, prompt: 'Spaceport with launch tower, rover, and research lab' }), undefined);
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', expect.objectContaining({ generation_method: 'nova' }));
      expect(llm).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
      expect(container.querySelector('[aria-label="Build progress workspace"] [aria-label="Bricks falling onto a table"]')).not.toBeNull();
      expect(container.querySelector('#landing-build-prompt')).toBeNull();
      expect(JSON.parse(localStorage.getItem(`pending_generations:v2:guest:${getGuestSession()}`)!)[0]).toMatchObject({ id: 'full-set', endpoint: 'novaToBricks' });
      vi.mocked(llm).mockResolvedValue({ generation_id: 'basic-bricks', message: 'Started' });
      act(() => Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Generation in progress actions"] button')).find(button => button.textContent === 'Start new')!.click());
      expect(container.querySelector('.pet-dialogue')?.textContent).toMatch(/brick building buddy|recent builds/);
      const nextMode = container.querySelector('#landing-builder-mode') as HTMLDivElement;
      act(() => nextMode.querySelector<HTMLButtonElement>('button[value="llm"]')!.click());
      expect(model.value).toBe(DEFAULT_LLM_MODEL);
      expect(nextMode.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('true');
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generation_method_selected', { generation_method: 'llm' });
      expect(container.querySelector('#all-parts-warning')).toBeNull();
      act(() => {
        const nextInput = container.querySelector('input[aria-label="Describe your model"]') as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nextInput, 'Red rover');
        nextInput.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => findButton('Generate').click());
      expect(llm).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Red rover', model: DEFAULT_LLM_MODEL }), undefined);
      expect(nova).toHaveBeenCalledTimes(1);

    } finally { act(() => root.unmount()); container.remove(); }
  });

  it.each(['llm', 'nova'])('sends the uploaded reference to the %s workflow from the shared bar', async modeValue => {
    vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => connectedProvider(id));
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });

    const llm = vi.spyOn(LlmToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'image-basic', message: 'Started' });
    const nova = vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'image-nova', message: 'Started' });
    const createUrl = vi.fn(() => 'blob:reference-image');
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter><LandingPage /></MemoryRouter>));
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_image_upload_control_shown', { page: '/', upload_position: 'landing_upload_card' });
      const choose = vi.spyOn(fileInput, 'click');
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Upload image"]')!.click());
      expect(choose).toHaveBeenCalledOnce();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_image_picker_opened', { page: '/', upload_position: 'landing_upload_card' });
      expect(llm).not.toHaveBeenCalled();
      expect(nova).not.toHaveBeenCalled();
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Tools"]')!.click());
      act(() => container.querySelector<HTMLButtonElement>('ul[aria-label="Tools"] [aria-label="Generation settings"]')!.click());
      expect(container.querySelector<HTMLDivElement>('#landing-generation-settings')!.hidden).toBe(false);
      await act(async () => {
        const mode = container.querySelector('#landing-builder-mode') as HTMLDivElement;
        mode.querySelector<HTMLButtonElement>(`button[value="${modeValue}"]`)!.click();
        Object.defineProperty(fileInput, 'files', { value: [new File(['reference'], 'reference.png', { type: 'image/png' })], configurable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.querySelector('img[alt="Uploaded preview"]')).not.toBeNull();
      expect(container.querySelector<HTMLDivElement>('#landing-generation-settings')!.hidden).toBe(true);
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      const selected = modeValue === 'nova' ? nova : llm;
      const other = modeValue === 'nova' ? llm : nova;
      expect(selected).toHaveBeenCalledWith(expect.objectContaining({
        model: DEFAULT_LLM_MODEL, prompt: undefined, imageBase64: btoa('reference'), imageMediaType: 'image/png',
      }), undefined);
      if (modeValue === 'nova') expect(nova).toHaveBeenCalledWith(expect.objectContaining({authMode:'native'}),undefined);
      expect(other).not.toHaveBeenCalled();
      expect(container.querySelector('[aria-label="Build buddy conversation"]')!.textContent).not.toContain('email');
      expect(container.querySelector('[aria-label="Build progress workspace"] [aria-label="Bricks falling onto a table"]')).not.toBeNull();
    } finally { act(() => root.unmount()); container.remove(); }
  });

  it('waits for an explicit provider connection choice and preserves the prompt before starting Nova', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({generation_count:12,brick_count:400});

    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => ({...connectedProvider(id),cli_connected:false,api_key_configured:true,login:{status:'disconnected'}}));
    const nova=vi.spyOn(NovaToBricksApiService,'generate').mockResolvedValue({generation_id:'selected-key',message:'Started'});
    const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
    try {
      await act(async()=>root.render(<LandingPage />));
      const input=container.querySelector<HTMLInputElement>('[aria-label="Describe your model"]')!;
      await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'A red lighthouse');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
      });
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Connect Claude');
      expect(nova).not.toHaveBeenCalled();
      const choice=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Use project API key')!;
      await act(async()=>choice.click());
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(input.value).toBe('A red lighthouse');
      await act(async()=>container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(nova).toHaveBeenCalledWith(expect.objectContaining({prompt:'A red lighthouse',model:'claude-opus-5-5',authMode:'api_key'}),undefined);
    } finally {act(()=>root.unmount());container.remove();}
  });

  it('keeps the original welcome spacing, hides stats, and fades the headline first', () => {
    const css = readFileSync('src/pages/LandingPage.css', 'utf8');
    expect(css).toContain('.landing-page.landing-page--welcome .landing-page-stats { display: none; }');
    expect(css).not.toContain('@media (max-height: 950px)');
    expect(css).toContain('min-height: 124px; padding: 24px 48px 16px');
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<LandingPage />);
    expect(container.querySelector('h1')?.className).toContain('landing-delay-2');
    expect(container.querySelector('.landing-hero-description')?.className).toContain('landing-delay-5');
    expect(container.querySelector('.landing-page-stats')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.landing-page-help')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('centers the welcome and thinking pets against their bubbles', () => {
    const css = readFileSync('src/pages/LandingPage.css', 'utf8');
    expect(css).toMatch(/\.pet-greeting,\s*\.landing-page \.pet-dialogue \.pet-chat-message:has\(\.pet-typing-indicator\)\s*\{ align-items: center;/);
    expect(css).toMatch(/\.pet-greeting > \.pet-avatar,\s*\.landing-page \.pet-dialogue \.pet-chat-message:has\(\.pet-typing-indicator\) > \.pet-avatar\s*\{ top: 50%; bottom: auto; translate: 0 -50%;/);
  });

  it('keeps the welcome bubble styling shared with other pet conversations and uses a gradient headline', () => {
    const css = readFileSync('src/pages/LandingPage.css', 'utf8');
    expect(css).toMatch(/\.landing-hero-title > span\s*\{[^}]*background: linear-gradient/);
    expect(css).toMatch(/\.landing-hero-title > span\s*\{[^}]*background-clip: text/);
    expect(css).not.toMatch(/\.landing-page[^{}]*--welcome[^{}]*\.pet-speech\s*\{/);
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(<LandingPage />);
    expect(container.querySelector('.pet-dialogue .pet-greeting > .pet-avatar')).not.toBeNull();
    expect(container.querySelector('.pet-dialogue .pet-greeting > .pet-speech')?.textContent).toMatch(/brick building buddy|recent builds/);
  });

  it('shows the upload-first hero, quiet welcome, and statistics', () => {
    const markup = renderToStaticMarkup(<LandingPage />);

    expect(markup).toContain('The Easiest Way to ');
    expect(markup).not.toContain('credit-nudge');
    expect(markup).toContain('landing-header-brand');
    expect(markup).toContain('Try something random');
    expect(markup).toContain('BrickBuilder is a free AI LEGO generator that turns text or images into ready-to-build LEGO models in under 30 minutes');
    expect(markup).toContain('Upload an image');
    expect(markup).toContain('Describe your idea');
    expect(markup).not.toContain('Show builds');
    expect(markup).not.toContain('Show me community models');
    const container = document.createElement('div');
    container.innerHTML = markup;
    expect(container.querySelector('.pet-greeting')?.textContent).toMatch(/brick building buddy|recent builds/);
    const form = container.querySelector('form[aria-label="Create a brick model"]')!;
    const stats = container.querySelector('[aria-label="BrickBuilder generation statistics"]')!;
    expect(stats).not.toBeNull();
    expect(stats.previousElementSibling?.tagName).toBe('MAIN');
    expect(stats.querySelector('.tabular-nums')?.className).toContain('text-[14px]');
    expect(stats.querySelector('.tabular-nums')?.className).toContain('sm:text-[16.8px]');
    expect(container.querySelector('h1')?.textContent).toBe('The Easiest Way to Make LEGO');
    expect(form.closest('[aria-label="Build dialogue"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Build buddy conversation"]')?.closest('[aria-label="Build dialogue"]')).toBe(form.closest('[aria-label="Build dialogue"]'));
    expect(container.querySelector('[aria-label="Build buddy conversation"]')?.closest('form')).toBeNull();
  });

  it('keeps settings collapsed and upload available in the browser and native shell', () => {
    expect(DEFAULT_GENERATION_METHOD).toBe('nova');
    expect(DEFAULT_LLM_MODEL).toBe('claude-opus-5-5');
    const verify = () => {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(<LandingPage />);
      const form = container.querySelector('form[aria-label="Create a brick model"]')!;
      const input = form.querySelector('input[aria-label="Describe your model"]')!;
      const create = form.querySelector('button[type="submit"]')!;
      expect(create.textContent?.trim()).toBe('Generate');
      expect(create.getAttribute('aria-label')).toBe('Generate');
      expect(create.classList.contains('landing-generate-button')).toBe(true);
      expect(input.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const model = form.querySelector('#landing-render-model') as HTMLSelectElement;
      const mode = form.querySelector('#landing-builder-mode') as HTMLDivElement;
      const upload = form.querySelector('[aria-label="Upload image"]')!;
      expect(model.value).toBe(DEFAULT_LLM_MODEL);
      expect(mode.querySelector('button[value="nova"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(model.parentElement!.parentElement).toBe(mode.parentElement);
      expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(mode.querySelector('select')).toBeNull();
      expect(upload.closest('#landing-generation-settings')).toBeNull();
      expect(upload.parentElement).toBe(input.parentElement);
      expect(upload.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(upload.textContent?.trim()).toBe('Upload an image');
      expect(input.getAttribute('placeholder')).toBe('Describe your idea');
      expect(upload.getAttribute('type')).toBe('button');
      expect(model.closest('#landing-generation-settings')?.hasAttribute('hidden')).toBe(true);
      expect(input.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(form.querySelector('[aria-label="Generation settings"]')).toBeNull();
      expect(container.querySelector<HTMLDivElement>('#landing-generation-settings')?.hidden).toBe(true);
      expect(container.querySelector('[aria-label="Upload glb"]')).toBeNull();
      expect(container.querySelector('[aria-label="Builder mode"]')).toBeNull();
      expect(Array.from(model.options).map(option => option.value)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5', 'gpt-6-astra']);
    };
    verify();
    window.__BRICKBUILDER_NATIVE_APP__ = Object.freeze({ platform: 'ios', version: '0.1.0' });
    try { verify(); } finally { delete window.__BRICKBUILDER_NATIVE_APP__; }
  });

  it('opens settings without submitting, preserves selections when closed, and dismisses with Escape', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 0 }) } as Response);
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

    const generate = vi.spyOn(LlmToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'settings-build', message: 'Started' });
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter><LandingPage /></MemoryRouter>));
      const tools = container.querySelector<HTMLButtonElement>('[aria-label="Tools"]')!;
      const panel = container.querySelector<HTMLDivElement>('#landing-generation-settings')!;
      const openSettings = () => {
        act(() => tools.click());
        act(() => container.querySelector<HTMLButtonElement>('ul[aria-label="Tools"] [aria-label="Generation settings"]')!.click());
      };
      expect(panel.hidden).toBe(true);
      expect(container.querySelector('form [aria-label="Generation settings"]')).toBeNull();
      expect(container.querySelector('[aria-label="Upload image"]')?.closest('[hidden]')).toBeNull();
      openSettings();
      expect(panel.hidden).toBe(false);
      const connections = container.querySelector('[aria-label="Local provider connections"]')!;
      expect(connections.closest('form')).toBeNull();
      expect(connections.closest('[hidden]')).toBeNull();
      act(() => panel.querySelector<HTMLButtonElement>('button[value="llm"]')!.click());
      const model = panel.querySelector<HTMLSelectElement>('#landing-render-model')!;
      act(() => { model.value = 'gpt-6-astra'; model.dispatchEvent(new Event('change', { bubbles: true })); });
      act(() => model.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(panel.hidden).toBe(true);
      expect(document.activeElement).toBe(tools);
      expect(connections.closest('[hidden]')).not.toBeNull();
      expect(generate).not.toHaveBeenCalled();
      openSettings();
      expect(model.value).toBe('gpt-6-astra');
      expect(panel.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('true');
      act(() => panel.querySelector<HTMLButtonElement>('[aria-label="Dismiss generation settings"]')!.click());
      const input = container.querySelector<HTMLInputElement>('[aria-label="Describe your model"]')!;
      act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'A red castle'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(generate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6-astra', prompt: 'A red castle' }), undefined);
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generation_settings_toggled', { expanded: false });
    } finally { act(() => root.unmount()); container.remove(); }
  });

  it('opens mobile settings from the Tools settings section, restores focus on dismissal, and closes when typing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 0 }) } as Response);
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });
    const generate = vi.spyOn(LlmToBricksApiService, 'generate');
    const container = document.createElement('div'); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter><LandingPage /></MemoryRouter>));
      expect(container.querySelector('form [aria-label="Generation settings"]')).toBeNull();
      const tools = container.querySelector<HTMLButtonElement>('[aria-label="Tools"]')!;
      const panel = container.querySelector<HTMLDivElement>('#landing-generation-settings')!;
      const openSettings = () => {
        act(() => tools.click());
        const option = container.querySelector<HTMLButtonElement>('ul[aria-label="Tools"] [aria-label="Generation settings"]')!;
        expect(option.textContent).toBe('Generation settings');
        expect(option.closest('li')?.classList.contains('sm:hidden')).toBe(false);
        expect(option.getAttribute('aria-controls')).toContain('landing-generation-settings');
        act(() => option.click());
        expect(panel.hidden).toBe(false);
        expect(container.querySelector('ul[aria-label="Tools"]')).toBeNull();
      };
      openSettings();
      const close = panel.querySelector<HTMLButtonElement>('[aria-label="Dismiss generation settings"]')!;
      expect(document.activeElement).toBe(close);
      act(() => panel.querySelector<HTMLButtonElement>('button[value="llm"]')!.click());
      const model = panel.querySelector<HTMLSelectElement>('#landing-render-model')!;
      act(() => { model.value = 'gpt-6-astra'; model.dispatchEvent(new Event('change', { bubbles: true })); });
      act(() => close.click());
      expect(panel.hidden).toBe(true);
      expect(document.activeElement).toBe(tools);
      openSettings();
      expect(model.value).toBe('gpt-6-astra');
      const input = container.querySelector<HTMLInputElement>('#landing-build-prompt')!;
      act(() => {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'A blue castle');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(panel.hidden).toBe(true);
      expect(input.value).toBe('A blue castle');
      expect(document.activeElement).toBe(input);
      expect(container.querySelector('[aria-label="Local provider connections"]')?.closest('[hidden]')).not.toBeNull();
      openSettings();
      act(() => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(panel.hidden).toBe(true);
      expect(document.activeElement).toBe(tools);
      expect(generate).not.toHaveBeenCalled();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_header_tools_item_clicked', expect.objectContaining({ tool: 'Generation settings' }));
    } finally { act(() => root.unmount()); container.remove(); }
  });

  it('model selection ignores unavailable models and disabled controls', async () => {
    const onChange = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    const capture = (await import('posthog-js')).default.capture;
    try {
      act(() => root.render(<GenerationModelSelector mode="nova" onChange={onChange} />));
      const select = container.querySelector('select')!;
      act(() => {
        select.value = 'gpt-5.6-sol';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalledWith('landing_render_model_selected', expect.anything());
      expect(capture).not.toHaveBeenCalledWith('landing_generation_method_selected', expect.anything());
      onChange.mockClear();
      act(() => root.render(<GenerationModelSelector mode="nova" disabled onChange={onChange} />));
      act(() => {
        select.value = 'gpt-5.5';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(select.disabled).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });
});

it('groups the header links in Tools and tracks selections for comparison', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 10 }) }));
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter><LandingPage /></MemoryRouter>));
    const nav = container.querySelector('header nav')!;
    const trigger = nav.querySelector<HTMLButtonElement>('button[aria-label="Tools"]')!;
    expect(trigger.textContent).toBe('Tools');
    expect(nav.querySelector('a[href^="/"]')).toBeNull();
    expect(container.querySelector('header [aria-label="Dashboard"]')).toBeNull();
    expect(trigger.getAttribute('aria-label')).toBe('Tools');
    expect(trigger.querySelector('span')?.className).toBe('hidden sm:inline');
    expect(trigger.querySelector('.lucide-wrench')).not.toBeNull();
    expect(container.querySelector('header a[href*="apps.apple.com"]')).toBeNull();
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const links = Array.from(nav.querySelectorAll('a[href^="/"]'));
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/image-to-lego', '/glb-to-lego', '/obj-to-lego', '/community',
    ]);
    const capture = (await import('posthog-js')).default.capture;
    expect(capture).toHaveBeenCalledWith('landing_header_tools_opened', expect.objectContaining({ navigation_layout: 'tools_dropdown' }));
    const github = nav.querySelector<HTMLAnchorElement>('ul a[href="https://github.com/for-real-labs/brickbuilder-ai"]')!;
    expect(github.textContent).toBe('GitHub');
    expect(github.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('[aria-label="View BrickBuilder on GitHub"]')).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith('https://api.github.com/repos/for-real-labs/brickbuilder-ai', expect.anything());
    act(() => github.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(capture).toHaveBeenCalledWith('landing_header_github_clicked', {
      page: '/', navigation_layout: 'tools_dropdown', destination: github.href, tool: 'GitHub',
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => trigger.click());
    act(() => nav.querySelector('a[href="/image-to-lego"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(capture).toHaveBeenCalledWith('landing_header_image_to_lego_clicked', expect.objectContaining({ destination: '/image-to-lego', navigation_layout: 'tools_dropdown' }));
    expect(capture).toHaveBeenCalledWith('landing_header_tools_item_clicked', expect.objectContaining({ tool: 'Image to LEGO' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => trigger.click());
    act(() => nav.querySelector('a[href="/image-to-lego"]')!.focus());
    act(() => nav.querySelector('a[href="/image-to-lego"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() => (nav.querySelector('a[href="/obj-to-lego"]') as HTMLAnchorElement).click());
    expect(capture).toHaveBeenCalledWith('landing_header_obj_to_lego_clicked', expect.objectContaining({ destination: '/obj-to-lego', navigation_layout: 'tools_dropdown' }));
    act(() => trigger.click());
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

it('labels the top-right auth action Sign up', async () => {
  authSettings.isSupabaseConfigured = true;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 10 }) }));
  vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });

  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LandingPage />));
    const buttons = Array.from(container.querySelectorAll('header button'));
    expect(buttons.some(button => button.textContent?.trim() === 'Sign up')).toBe(true);
    expect(buttons.some(button => button.textContent?.trim() === 'Login')).toBe(false);
    expect(container.querySelector('header [aria-label^="Notifications"]')).toBeNull();
  } finally { act(() => root.unmount()); authSettings.isSupabaseConfigured = false; vi.unstubAllGlobals(); }
});

it('positions the render-model chevron inside the select without intercepting input', () => {
  const markup = renderToStaticMarkup(<GenerationModelSelector model={DEFAULT_LLM_MODEL} onChange={() => {}} />);
  const container = document.createElement('div');
  container.innerHTML = markup;
  const select = container.querySelector('select')!;
  const chevron = select.parentElement!.querySelector('svg')!;
  expect(select.classList.contains('appearance-none')).toBe(true);
  expect(select.classList.contains('pr-10')).toBe(true);
  expect(select.parentElement!.classList.contains('relative')).toBe(true);
  expect(chevron.getAttribute('aria-hidden')).toBe('true');
  expect(chevron.classList.contains('pointer-events-none')).toBe(true);
  expect(chevron.classList.contains('top-1/2')).toBe(true);
  expect(chevron.classList.contains('right-3')).toBe(true);
});

it.each(['claude-haiku-5-5', 'gpt-6-astra'])('selects %s for either generation mode and records the provider', async model => {
  const onChange = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  const capture = (await import('posthog-js')).default.capture;
  try {
    act(() => root.render(<GenerationModelSelector model="claude-opus-5-5" mode="nova" onChange={onChange} />));
    const select = container.querySelector('select')!;
    act(() => { select.value = model; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith(model);
    expect(capture).toHaveBeenCalledWith('landing_render_model_selected', {
      generation_method: 'nova', model, provider: model.startsWith('claude-') ? 'anthropic' : 'openai',
    });
  } finally { act(() => root.unmount()); }
});


it('starts the free trial in All parts without a credit caption and allows Basic selection', async () => {
  billingSettings.enabled = true;
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LandingPage />));
    expect(container.querySelector('button[value="nova"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.billing-generation-quote')).toBeNull();
    expect([...container.querySelectorAll('header button')].some(button => button.textContent === 'Plans')).toBe(false);
    act(() => container.querySelector<HTMLButtonElement>('button[value="llm"]')!.click());
    expect(container.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.billing-generation-quote')).toBeNull();
  } finally { act(() => root.unmount()); }
});


it('places loading credits immediately before Tools, without a GitHub button or plans banner', () => {
  authSettings.user = { id: 'builder' };
  billingSettings.enabled = true;
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<LandingPage />);
  expect(container.querySelector('.landing-header-brand .credit-balance')).toBeNull();
  expect(container.querySelector('nav .credit-balance')).not.toBeNull();
  expect(container.querySelector('nav .credit-balance')?.nextElementSibling?.querySelector('[aria-label="Tools"]')).not.toBeNull();
  expect(container.querySelector('.credit-count')?.textContent).toBe('…');
  expect(container.querySelector('.credit-nudge')).toBeNull();
});


it('positions the stats independently of document flow with room below their center', () => {
  const style = document.createElement('style');
  style.textContent = readFileSync('src/pages/LandingPage.css', 'utf8');
  document.head.append(style);
  const stats = document.createElement('div');
  stats.className = 'landing-page-stats';
  document.body.append(stats);
  try {
    const computed = getComputedStyle(stats);
    expect(computed.position).toBe('absolute');
    expect(computed.display).toBe('grid');
    expect(computed.textAlign).toBe('center');
    expect(computed.gridTemplateColumns).toBe('minmax(0, 140px) 1px minmax(0, 140px)');
    expect(computed.translate).toBe('0 50%');
    expect(computed.paddingBottom).toBe('12px');
    stats.classList.add('landing-page-stats--hidden');
    expect(getComputedStyle(stats).display).toBe('none');
  } finally { stats.remove(); style.remove(); }
});
