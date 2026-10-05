import { getGuestSession } from '../src/utils/guestSession';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';
import { describe, expect, it, vi } from 'vitest';

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
  };
});

const authSettings = vi.hoisted(() => ({ isSupabaseConfigured: false }));

vi.mock('../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: null,
    loading: false,
    user: null,
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
  SiteFooter: () => null,
}));

vi.mock('../src/components/GlbUploadCard', () => ({
  GlbUploadCard: () => null,
}));

vi.mock('../src/components/ProfileMenu', () => ({
  ProfileMenu: () => null,
}));

import LandingPage, { DEFAULT_GENERATION_METHOD, GenerationModelSelector, FeaturedStrip } from '../src/pages/LandingPage';
import { DEFAULT_LLM_MODEL } from '../src/services/llmToBricksApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';
import { GetGenerationStatsApiService } from '../src/services/getGenerationStatsApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { GetCommunityGenerationsApiService } from '../src/services/getCommunityGenerationsApi';
import { NovaToBricksApiService, DEFAULT_NOVA_OPTIONS } from '../src/services/novaToBricksApi';
import { TextToBricksApiService } from '../src/services/textToBricksApi';
import { ImageToBricksApiService } from '../src/services/imageToBricksApi';
import { LocalProvidersApiService, type LocalProviderStatus } from '../src/services/localProvidersApi';

const connectedProvider = (id: LocalProviderStatus['id']): LocalProviderStatus => ({
  id, label: id, api_key_configured: false, cli_available: true, cli_connected: true,
  login: { status: 'connected' }, capabilities: ['browser_login'],
});

describe('LandingPage', () => {
  it.each(['sam3d', 'trellis'])('routes Other model %s to the 3D provider and returns to Basic bricks for LLM models', async selected => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 0, brick_count: 0 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    const text = vi.spyOn(TextToBricksApiService, 'generateBricksFromTextStream').mockRejectedValue(new Error('Test 3D request'));
    const image = vi.spyOn(ImageToBricksApiService, 'generateBricksFromImageStream').mockRejectedValue(new Error('Test image request'));
    const llm = vi.spyOn(LlmToBricksApiService, 'generate').mockRejectedValue(new Error('Test basic request'));
    const BrowserURL = URL;
    vi.stubGlobal('URL', class extends BrowserURL {
      static createObjectURL = vi.fn(() => 'blob:test-image');
      static revokeObjectURL = vi.fn();
    });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const model = container.querySelector('#landing-render-model') as HTMLSelectElement;
      expect(Array.from(model.querySelectorAll('optgroup')).map(group => group.label)).toEqual(['Claude', 'OpenAI', 'Other']);
      const mode = container.querySelector('#landing-builder-mode') as HTMLDivElement;
      const prompt = container.querySelector('[aria-label="Describe your model"]') as HTMLInputElement;
      act(() => {
        model.value = selected;
        model.dispatchEvent(new Event('change', { bubbles: true }));
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(prompt, 'Blue car');
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(model.value).toBe(selected);
      expect(Array.from(mode.querySelectorAll('button')).every(button => button.disabled)).toBe(true);
      const create = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Create')!;
      await act(async () => create.click());
      expect(text.mock.calls[0][6]).toBe(selected === 'sam3d');
      expect(llm).not.toHaveBeenCalled();
      const upload = container.querySelector('input[type=file]') as HTMLInputElement;
      act(() => {
        Object.defineProperty(upload, 'files', { configurable: true, value: [new File(['image'], 'car.png', { type: 'image/png' })] });
        upload.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await act(async () => {
        create.click();
        await vi.waitFor(() => expect(image).toHaveBeenCalledTimes(1));
      });
      expect(image.mock.calls[0][6]).toBe(selected === 'sam3d');
      act(() => {
        model.value = 'gpt-5.5';
        model.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(Array.from(mode.querySelectorAll('button')).every(button => !button.disabled)).toBe(true);
      expect(mode.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('true');
      await act(async () => {
        create.click();
        await vi.waitFor(() => expect(llm).toHaveBeenCalledTimes(1));
      });
      expect(llm).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }), undefined);
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_render_model_selected', {
        generation_method: '3d', model: selected, provider: 'fal',
      });
    } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
  });

  it.each(['accepted', 'failed'])('submits an image with Enter and clears it only when %s', async outcome => {
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const BrowserURL = URL;
    vi.stubGlobal('URL', class extends BrowserURL {
      static createObjectURL = vi.fn(() => 'blob:uploaded-image');
      static revokeObjectURL = vi.fn();
    });
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
      expect(prompt.disabled).toBe(true);
      await act(async () => {
        prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(start).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === 'accepted') accept({ generation_id: 'submitted', message: 'Started' });
        else reject(new Error('Submission failed'));
      });
      if (outcome === 'accepted') {
        expect(container.querySelector('[alt="Uploaded preview"]')).toBeNull();
        expect(container.querySelector('[aria-label="Remove image"]')).toBeNull();
        expect(fileInput.value).toBe('');
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:uploaded-image');
        await act(async () => {
          prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: 'Anime girl', imageBase64: undefined }), undefined);
      } else {
        expect(container.querySelector('[alt="Uploaded preview"]')).toBeTruthy();
        expect(container.textContent).toContain('Submission failed');
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
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
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
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const generateAi = vi.spyOn(LlmToBricksApiService, 'generate');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const generate = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Create')!;
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

  it('describes the physical builds at the Brickworld Chicago LEGO convention', async () => {
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      expect(container.textContent).toContain('BrickBuilder AI creations physically built at the Brickworld Chicago LEGO convention.');
      expect(container.querySelector('img[src="/assets/blog/brickworld26/brickbuilderai-models.jpg"]')?.getAttribute('alt')).toContain('the Brickworld Chicago LEGO convention');
      expect(container.innerHTML).not.toContain('Meme World');
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['stats', 'community'])('waits for %s before mounting lower content', async delayed => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockImplementation(async () => {
      if (delayed === 'stats') await pending;
      return { generation_count: 12, brick_count: 400 };
    });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockImplementation(async () => {
      if (delayed === 'community') await pending;
      return { generations: [], total_count: 0, has_more: false };
    });
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      expect(container.querySelector('#how-it-works')).toBeNull();
      expect(container.textContent).toContain('Create');
      await act(async () => { finish(); await pending; });
      expect(container.querySelector('#how-it-works')).toBeTruthy();
      expect(container.querySelector('.landing-scroll-reveal .landing-visible')).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });

  it('fades lower elements only when they enter the viewport', async () => {
    let callback!: IntersectionObserverCallback;
    const observe = vi.fn();
    const unobserve = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(next: IntersectionObserverCallback) { callback = next; }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    });
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    const root = createRoot(document.createElement('div'));
    try {
      await act(async () => root.render(<LandingPage />));
      const target = observe.mock.calls[0][0] as Element;
      expect(target.classList.contains('landing-visible')).toBe(false);
      callback([{ target, isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver);
      expect(target.classList.contains('landing-visible')).toBe(false);
      callback([{ target, isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver);
      expect(target.classList.contains('landing-visible')).toBe(true);
      expect(unobserve).toHaveBeenCalledWith(target);
    } finally {
      act(() => root.unmount());
      expect(disconnect).toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
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
      await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Create')!.click());
      expect(start).not.toHaveBeenCalled();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', expect.objectContaining({ has_prompt: false, has_image: false }));
      const input = container.querySelector('input:not([type="file"])') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Red castle');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const generate = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Create')!;
      await act(async () => generate().click());
      expect(container.textContent).toContain('1 in progress');
      expect(input.disabled).toBe(false);
      await act(async () => generate().click());
      expect(container.querySelectorAll('[aria-label="Your generations"] article')).toHaveLength(2);
      expect(container.textContent).toContain('2 in progress');
      expect(start).toHaveBeenCalledTimes(2);
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', {
        generation_method: 'llm', model: DEFAULT_LLM_MODEL, has_prompt: true,
        has_image: false, size: 'big', is_authenticated: false,
      });
      expect(stream).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
      expect(JSON.parse(localStorage.getItem(`pending_generations:v2:guest:${getGuestSession()}`)!).map((row: { id: string }) => row.id)).toEqual(['two', 'one']);
      await act(async () => Array.from(container.querySelectorAll('[aria-label="Your generations"] article button')).find(button => button.textContent?.includes('Cancel generation'))!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(cancel).toHaveBeenCalledWith('two');
      expect(container.textContent).toContain('Generation cancelled');
      expect(container.textContent).toContain('1 in progress');
      expect(input.value).toBe('Red castle');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps the selected model when switching modes and routes All parts through Nova', async () => {
    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => connectedProvider(id));
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    const nova = vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'full-set', message: 'Started' });
    const llm = vi.spyOn(LlmToBricksApiService, 'generate');
    const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const findButton = (text: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(text))!;
    try {
      await act(async () => root.render(<LandingPage />));
      const mode = container.querySelector('#landing-builder-mode') as HTMLDivElement;
      const model = container.querySelector('#landing-render-model') as HTMLSelectElement;
      expect(mode.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(Array.from(mode.querySelectorAll('button')).map(button => button.textContent)).toEqual(['Basic bricks', 'All parts']);
      expect(container.querySelector('#all-parts-warning')).toBeNull();
      expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      await act(async () => {
        model.value = 'gpt-5.6-sol';
        model.dispatchEvent(new Event('change', { bubbles: true }));
        mode.querySelector<HTMLButtonElement>('button[value="nova"]')!.click();
      });
      expect(model.value).toBe('gpt-5.6-sol');
      expect(container.querySelector('#all-parts-warning')?.textContent).toContain('Warning: all parts mode is experimental. Generations take up to 30 minutes and output needs to be verified in instructions.');
      expect(mode.getAttribute('aria-describedby')).toBe('all-parts-warning');
      const warning = container.querySelector('#all-parts-warning')!;
      expect(container.querySelector('[aria-label="Describe your model"]')!.compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(warning.compareDocumentPosition(mode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generation_method_selected', { generation_method: 'nova' });
      const input = container.querySelector('input[aria-label="Describe your model"]') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Spaceport with launch tower, rover, and research lab');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => findButton('Create').click());
      expect(nova).toHaveBeenCalledWith(expect.objectContaining({ ...DEFAULT_NOVA_OPTIONS, authMode: 'native', model: 'gpt-5.6-sol', prompt: input.value }), undefined);
      expect(llm).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
      expect(container.textContent).toContain('1 in progress');
      expect(input.disabled).toBe(false);
      expect(JSON.parse(localStorage.getItem(`pending_generations:v2:guest:${getGuestSession()}`)!)[0]).toMatchObject({ id: 'full-set', endpoint: 'novaToBricks' });
      vi.mocked(llm).mockResolvedValue({ generation_id: 'basic-bricks', message: 'Started' });
      act(() => {
        mode.querySelector<HTMLButtonElement>('button[value="llm"]')!.click();
      });
      expect(model.value).toBe('gpt-5.6-sol');
      expect(container.querySelector('#all-parts-warning')).toBeNull();
      await act(async () => findButton('Create').click());
      expect(llm).toHaveBeenCalledWith(expect.objectContaining({ prompt: input.value, model: 'gpt-5.6-sol' }), undefined);
      expect(nova).toHaveBeenCalledTimes(1);

    } finally { act(() => root.unmount()); container.remove(); }
  });

  it.each(['llm', 'nova'])('sends the uploaded reference to the %s workflow from the shared bar', async modeValue => {
    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => connectedProvider(id));
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    const llm = vi.spyOn(LlmToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'image-basic', message: 'Started' });
    const nova = vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'image-nova', message: 'Started' });
    const createUrl = vi.fn(() => 'blob:reference-image');
    Object.defineProperty(URL, 'createObjectURL', { value: createUrl, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<LandingPage />));
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      const choose = vi.spyOn(fileInput, 'click');
      act(() => container.querySelector<HTMLButtonElement>('[aria-label="Upload image"]')!.click());
      expect(choose).toHaveBeenCalledOnce();
      await act(async () => {
        const mode = container.querySelector('#landing-builder-mode') as HTMLDivElement;
        mode.querySelector<HTMLButtonElement>(`button[value="${modeValue}"]`)!.click();
        Object.defineProperty(fileInput, 'files', { value: [new File(['reference'], 'reference.png', { type: 'image/png' })], configurable: true });
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(container.querySelector('img[alt="Uploaded preview"]')).not.toBeNull();
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
    } finally { act(() => root.unmount()); container.remove(); }
  });

  it('waits for an explicit provider connection choice and preserves the prompt before starting Nova', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({generation_count:12,brick_count:400});
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({generations:[],total_count:0,has_more:false});
    vi.spyOn(LocalProvidersApiService, 'getProviderStatus').mockImplementation(async id => ({...connectedProvider(id),cli_connected:false,api_key_configured:true,login:{status:'disconnected'}}));
    const nova=vi.spyOn(NovaToBricksApiService,'generate').mockResolvedValue({generation_id:'selected-key',message:'Started'});
    const container=document.createElement('div');document.body.appendChild(container);const root=createRoot(container);
    try {
      await act(async()=>root.render(<LandingPage />));
      const input=container.querySelector<HTMLInputElement>('[aria-label="Describe your model"]')!;
      await act(async()=>{
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'A red lighthouse');
        input.dispatchEvent(new Event('input',{bubbles:true}));
        const mode=container.querySelector<HTMLDivElement>('#landing-builder-mode')!;
        mode.querySelector<HTMLButtonElement>('button[value="nova"]')!.click();
      });
      expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Connect Claude');
      expect(nova).not.toHaveBeenCalled();
      const choice=Array.from(container.querySelectorAll('button')).find(button=>button.textContent==='Use project API key')!;
      await act(async()=>choice.click());
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(input.value).toBe('A red lighthouse');
      await act(async()=>container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
      expect(nova).toHaveBeenCalledWith(expect.objectContaining({prompt:'A red lighthouse',authMode:'api_key'}),undefined);
    } finally {act(()=>root.unmount());container.remove();}
  });

  it('shows the top eight community models with chevron controls', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({
      generations: Array.from({ length: 8 }, (_, index) => ({
        id: `generation-${index + 1}`,
        user_id: `owner-${index + 1}`,
        user_type: 'authenticated',
        prompt: 'castle',
        name: `Model ${index + 1}`,
        detail_level: 10,
        endpoint: 'llm',
        created_at: '2026-09-26T00:00:00Z',
        status: 'completed',
        preview_image_url: `https://example.com/model-${index + 1}.png`,
        username: `builder-${index + 1}`,
        like_count: 20 - index,
      })),
      total_count: 8,
      has_more: false,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ stargazers_count: 10 }),
    }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<LandingPage />));

      expect(container.querySelector('[aria-label="Scroll community models left"]')).toBeTruthy();
      expect(container.querySelector('[aria-label="Scroll community models right"]')).toBeTruthy();
      expect(Array.from(container.querySelectorAll('[data-featured-copy="0"] button')).filter((button) => button.textContent?.includes('View Model'))).toHaveLength(8);
      expect(container.textContent).toContain('Model 1');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('disables carousel arrows when there is only one distinct model', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({
      generations: [{
        id: 'generation-1',
        user_id: 'owner-1',
        user_type: 'authenticated',
        prompt: 'castle',
        name: 'Solo Model',
        detail_level: 10,
        endpoint: 'llm',
        created_at: '2026-09-26T00:00:00Z',
        status: 'completed',
        preview_image_url: 'https://example.com/model-1.png',
        username: 'builder-1',
        like_count: 9,
      }],
      total_count: 1,
      has_more: false,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ stargazers_count: 10 }),
    }));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(<LandingPage />));

      expect((container.querySelector('[aria-label="Scroll community models left"]') as HTMLButtonElement).disabled).toBe(true);
      expect((container.querySelector('[aria-label="Scroll community models right"]') as HTMLButtonElement).disabled).toBe(true);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('uses the updated hero headline', () => {
    const markup = renderToStaticMarkup(<LandingPage />);

    expect(markup).toContain('Imagine. Create. Build.');
    expect(markup).not.toContain('Create and Build');
  });

  it('shows the compact controls in the browser and native shell', () => {
    expect(DEFAULT_GENERATION_METHOD).toBe('llm');
    expect(DEFAULT_LLM_MODEL).toBe('claude-opus-5-5');
    const verify = () => {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(<LandingPage />);
      const form = container.querySelector('form[aria-label="Create a brick model"]')!;
      const input = form.querySelector('input[aria-label="Describe your model"]')!;
      const create = form.querySelector('button[type="submit"]')!;
      expect(create.textContent?.trim()).toBe('Create');
      expect(create.parentElement).toBe(input.parentElement);
      const model = form.querySelector('#landing-render-model') as HTMLSelectElement;
      const mode = form.querySelector('#landing-builder-mode') as HTMLDivElement;
      const upload = form.querySelector('[aria-label="Upload image"]')!;
      expect(model.value).toBe(DEFAULT_LLM_MODEL);
      expect(mode.querySelector('button[value="llm"]')?.getAttribute('aria-pressed')).toBe('true');
      expect(model.parentElement!.parentElement).toBe(mode.parentElement);
      expect(mode.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(mode.querySelector('select')).toBeNull();
      expect(upload.parentElement).toBe(model.parentElement!.parentElement);
      expect(input.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(container.querySelector('[aria-label="Toggle settings"]')).toBeNull();
      expect(container.querySelector('[aria-label="Upload glb"]')).toBeNull();
      expect(container.querySelector('[aria-label="Builder mode"]')).toBeNull();
      expect(Array.from(model.options).map(option => option.value)).toContain('sam3d');
      expect(Array.from(model.options).map(option => option.value)).toContain('trellis');
    };
    verify();
    window.__BRICKBUILDER_NATIVE_APP__ = Object.freeze({ platform: 'ios', version: '0.1.0' });
    try { verify(); } finally { delete window.__BRICKBUILDER_NATIVE_APP__; }
  });

  it('model selection preserves Nova mode and ignores disabled controls', async () => {
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
      expect(onChange).toHaveBeenCalledWith('gpt-5.6-sol');
      expect(capture).toHaveBeenCalledWith('landing_render_model_selected', {
        generation_method: 'nova', model: 'gpt-5.6-sol', provider: 'openai',
      });
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

it('labels the top-right auth action Sign up', async () => {
  authSettings.isSupabaseConfigured = true;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ stargazers_count: 10 }) }));
  vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
  vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LandingPage />));
    const buttons = Array.from(container.querySelectorAll('header button'));
    expect(buttons.some(button => button.textContent?.trim() === 'Sign up')).toBe(true);
    expect(buttons.some(button => button.textContent?.trim() === 'Login')).toBe(false);
  } finally { act(() => root.unmount()); authSettings.isSupabaseConfigured = false; vi.unstubAllGlobals(); }
});

it.each([2, 3, 8].flatMap(count => [390, 1440, 3714, 5120].map(width => ({ count, width }))))('fills a $width px viewport and centers $count models through scrolling and resizing', ({ count, width }) => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`, title: `Model ${index}`, imageUrl: null,
    creator: null, createdAt: '2026-10-01', likeCount: count - index,
  }));
  const loopCount = Math.ceil(8 / count) * count;
  const loopWidth = loopCount * 144;
  let viewportWidth = width;
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const width = this.tagName === 'ARTICLE' ? 120 : this.hasAttribute('data-featured-copy') ? loopWidth : viewportWidth;
    return { width, height: 200, top: 0, left: 0, bottom: 200, right: width, x: 0, y: 0, toJSON() {} } as DOMRect;
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const transform = () => container.querySelector<HTMLElement>('[data-featured-track]')!.style.transform;
  try {
    act(() => root.render(<FeaturedStrip items={items} />));
    const initialOffset = ((loopWidth - (viewportWidth - 120) / 2) % loopWidth + loopWidth) % loopWidth;
    expect(transform()).toBe(`translate3d(${-initialOffset}px, 0, 0)`);
    const titles = Array.from(container.querySelectorAll('h3')).map(title => title.textContent);
    expect(titles).toEqual(Array.from({ length: loopCount * Math.max(2, Math.ceil(viewportWidth / loopWidth) + 1) }, (_, index) => `Model ${index % count}`));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Scroll community models right"]')!.click());
    expect(transform()).toBe(`translate3d(${-((initialOffset + 144) % loopWidth)}px, 0, 0)`);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Scroll community models right"]')!.click());
    expect(transform()).toBe(`translate3d(${-((initialOffset + 288) % loopWidth)}px, 0, 0)`);
    const expectFilled = () => {
      const copies = container.querySelectorAll('[data-featured-copy]').length;
      const offset = -Number(transform().match(/translate3d\(([-\d.]+)px/)![1]);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(loopWidth);
      expect(copies * loopWidth - offset).toBeGreaterThanOrEqual(viewportWidth);
    };
    expectFilled();
    // Sweep beyond a full loop in both directions, including its wrap boundary.
    for (const direction of ['right', 'left']) {
      for (let step = 0; step < loopCount * 2; step++) {
        act(() => container.querySelector<HTMLButtonElement>(`[aria-label="Scroll community models ${direction}"]`)!.click());
        expectFilled();
      }
    }
    for (const resizedWidth of [390, 5120, 1440]) {
      viewportWidth = resizedWidth;
      act(() => resize());
      const centeredOffset = ((loopWidth - (viewportWidth - 120) / 2) % loopWidth + loopWidth) % loopWidth;
      expect(transform()).toBe(`translate3d(${-centeredOffset}px, 0, 0)`);
      expectFilled();
    }
  } finally {
    act(() => root.unmount());
    geometry.mockRestore();
    vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalledOnce();
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
