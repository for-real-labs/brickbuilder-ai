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

import LandingPage, { DEFAULT_GENERATION_METHOD, DEFAULT_THREE_D_MODEL, GenerationMethodSelector, FeaturedStrip } from '../src/pages/LandingPage';
import { DEFAULT_LLM_MODEL } from '../src/services/llmToBricksApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';
import { GetGenerationStatsApiService } from '../src/services/getGenerationStatsApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { GetCommunityGenerationsApiService } from '../src/services/getCommunityGenerationsApi';
import { NovaToBricksApiService, DEFAULT_NOVA_OPTIONS } from '../src/services/novaToBricksApi';

describe('LandingPage', () => {
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
      expect(container.textContent).toContain('Generate');
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
      await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Generate')!.click());
      expect(start).not.toHaveBeenCalled();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generate_clicked', expect.objectContaining({ has_prompt: false, has_image: false }));
      const input = container.querySelector('input:not([type="file"])') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Red castle');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const generate = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Generate')!;
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
      await act(async () => container.querySelector('[aria-label="Your generations"] article button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
      expect(cancel).toHaveBeenCalledWith('two');
      expect(container.textContent).toContain('Generation cancelled');
      expect(container.textContent).toContain('1 in progress');
      expect(input.value).toBe('Red castle');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('keeps Nova optional and starts a full set job through the existing generation activity flow', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    vi.spyOn(GetCommunityGenerationsApiService, 'getCommunityGenerations').mockResolvedValue({ generations: [], total_count: 0, has_more: false });
    const nova = vi.spyOn(NovaToBricksApiService, 'generate').mockResolvedValue({ generation_id: 'full-set', message: 'Started' });
    const llm = vi.spyOn(LlmToBricksApiService, 'generate');
    const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete');
    const container = document.createElement('div');
    const root = createRoot(container);
    const findButton = (text: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes(text))!;
    try {
      await act(async () => root.render(<LandingPage />));
      expect(findButton('Model builder').getAttribute('aria-pressed')).toBe('true');
      expect(findButton('Full set agent').getAttribute('aria-pressed')).toBe('false');
      expect(container.querySelector('[aria-label="Full set agent options"]')).toBeNull();
      act(() => findButton('Full set agent').click());
      expect(container.querySelector('[aria-label="Full set agent options"]')).not.toBeNull();
      expect((await import('posthog-js')).default.capture).toHaveBeenCalledWith('landing_generation_method_selected', { generation_method: 'nova' });
      const input = container.querySelector('textarea[aria-label="Full set description"]') as HTMLTextAreaElement;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Spaceport with launch tower, rover, and research lab');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => findButton('Generate').click());
      expect(nova).toHaveBeenCalledWith(expect.objectContaining({ ...DEFAULT_NOVA_OPTIONS, prompt: input.value }), undefined);
      expect(llm).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
      expect(container.textContent).toContain('1 in progress');
      expect(input.disabled).toBe(false);
      expect(JSON.parse(localStorage.getItem(`pending_generations:v2:guest:${getGuestSession()}`)!)[0]).toMatchObject({ id: 'full-set', endpoint: 'novaToBricks' });
    } finally { act(() => root.unmount()); }
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

  it('defaults to LLM Render with Claude Opus 5.5, and SAM3D for image-to-glb', () => {
    expect(DEFAULT_GENERATION_METHOD).toBe('llm');
    expect(DEFAULT_THREE_D_MODEL).toBe('sam3d');
    expect(DEFAULT_LLM_MODEL).toBe('claude-opus-5-5');

    const markup = renderToStaticMarkup(
      <GenerationMethodSelector value="3d" onChange={() => undefined} />,
    );
    expect(markup).toContain('Render model:');
    expect(markup).not.toContain('3D Render');
    expect(markup).not.toContain('LLM Render');
    expect(markup).not.toContain('Generation method:');
    expect(markup).not.toMatch(/>image-to-glb<\/button>/);
    expect(markup).toContain('<optgroup label="image-to-glb">');
    expect(markup).toMatch(/<option value="sam3d"[^>]*selected="">SAM3D<\/option>/);
    expect(markup).toContain('Claude Opus 5.5');
    expect(markup).toContain('Trellis');
  });

  it('offers SAM3D and Trellis in the image-to-glb optgroup without old 3D style controls', () => {
    const markup = renderToStaticMarkup(
      <GenerationMethodSelector value="3d" threeDModel="trellis" onChange={() => undefined} />,
    );

    expect(markup).not.toContain('Generation method:');
    expect(markup).toContain('Render model:');
    expect(markup).not.toMatch(/>image-to-glb<\/button>/);
    expect(markup).toContain('<optgroup label="image-to-glb">');
    expect(markup).toMatch(/<option value="trellis"[^>]*selected="">Trellis<\/option>/);
    expect(markup).not.toContain('3D model:');
  });

  it('offers grouped image-to-glb, Claude, and OpenAI models for LLM Render, defaulting to Opus 5.5', () => {
    const markup = renderToStaticMarkup(
      <GenerationMethodSelector value="llm" onChange={() => undefined} />,
    );

    expect(markup).toContain('Render model:');
    expect(markup).toContain('<optgroup label="image-to-glb">');
    expect(markup).toContain('<optgroup label="Claude">');
    expect(markup).toContain('<optgroup label="OpenAI">');
    expect(markup).toMatch(/<option value="claude-opus-5-5"[^>]*selected="">Claude Opus 5.5<\/option>/);
    expect(markup).toMatch(/<option value="gpt-5.6-sol"[^>]*>GPT-5.6 Sol<\/option>/);
    expect(markup).toContain('SAM3D');
    expect(markup).not.toContain('Generation method:');
  });

  it('reports method changes and model selections through the shared controls', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const onThreeDModelChange = vi.fn();
    const onLlmModelChange = vi.fn();
    const capture = (await import('posthog-js')).default.capture;

    try {
      act(() => {
        root.render(
          <GenerationMethodSelector
            value="llm"
            onChange={onChange}
            onThreeDModelChange={onThreeDModelChange}
            onLlmModelChange={onLlmModelChange}
          />,
        );
      });

      const renderModelSelect = container.querySelector('select') as HTMLSelectElement;
      act(() => {
        renderModelSelect.value = 'trellis';
        renderModelSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith('3d');
      expect(onThreeDModelChange).toHaveBeenCalledWith('trellis');
      expect(capture).toHaveBeenCalledWith('landing_generation_method_selected', {
        generation_method: '3d',
      });
      expect(capture).toHaveBeenCalledWith('landing_render_model_selected', {
        generation_method: '3d',
        model: 'trellis',
        provider: '3d',
      });

      const llmSelect = container.querySelector('select') as HTMLSelectElement;
      act(() => {
        llmSelect.value = 'gpt-5.6-sol';
        llmSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onLlmModelChange).toHaveBeenCalledWith('gpt-5.6-sol');
      expect(capture).toHaveBeenCalledWith('landing_render_model_selected', {
        generation_method: 'llm',
        model: 'gpt-5.6-sol',
        provider: 'openai',
      });

      act(() => {
        root.render(
          <GenerationMethodSelector
            value="3d"
            threeDModel="sam3d"
            onChange={onChange}
            onThreeDModelChange={onThreeDModelChange}
            onLlmModelChange={onLlmModelChange}
          />,
        );
      });
      onChange.mockClear();
      onThreeDModelChange.mockClear();
      onLlmModelChange.mockClear();
      vi.mocked(capture).mockClear();

      const threeDSelect = container.querySelector('select') as HTMLSelectElement;
      act(() => {
        threeDSelect.value = 'sam3d';
        threeDSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(onThreeDModelChange).not.toHaveBeenCalled();
      expect(onLlmModelChange).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();

      vi.mocked(capture).mockClear();

      act(() => {
        threeDSelect.value = 'trellis';
        threeDSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(onThreeDModelChange).toHaveBeenCalledWith('trellis');
      expect(capture).not.toHaveBeenCalledWith('landing_generation_method_selected', {
        generation_method: '3d',
      });
      expect(capture).toHaveBeenCalledWith('landing_render_model_selected', {
        generation_method: '3d',
        model: 'trellis',
        provider: '3d',
      });

      onChange.mockClear();
      onLlmModelChange.mockClear();
      vi.mocked(capture).mockClear();

      act(() => {
        threeDSelect.value = 'claude-opus-5-5';
        threeDSelect.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith('llm');
      expect(onLlmModelChange).toHaveBeenCalledWith('claude-opus-5-5');
      expect(capture).toHaveBeenCalledWith('landing_generation_method_selected', {
        generation_method: 'llm',
      });
      expect(capture).toHaveBeenCalledWith('landing_render_model_selected', {
        generation_method: 'llm',
        model: 'claude-opus-5-5',
        provider: 'anthropic',
      });
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('expands the shared method and model controls by default in the native shell', () => {
    window.__BRICKBUILDER_NATIVE_APP__ = Object.freeze({
      platform: 'ios',
      version: '0.1.0',
    });

    try {
      const markup = renderToStaticMarkup(<LandingPage />);

      expect(markup).not.toContain('Generation method:');
      expect(markup).toContain('<optgroup label="image-to-glb">');
      expect(markup).not.toMatch(/>image-to-glb<\/button>/);
      expect(markup).not.toContain('3D Render');
      expect(markup).not.toContain('LLM Render');
      expect(markup).toContain('Render model:');
      expect(markup).toContain('Claude Opus 5.5');
      expect(markup).toContain('GPT-5.6 Sol');
      expect(markup).not.toContain('Style:');
      expect(markup).not.toContain('Plush');
      expect(markup).not.toContain('Block');
    } finally {
      delete window.__BRICKBUILDER_NATIVE_APP__;
    }
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

it.each([3, 8])('centers the first community model and wraps %s models in their original order', count => {
  const items = Array.from({ length: count }, (_, index) => ({
    id: `model-${index}`, title: `Model ${index}`, imageUrl: null,
    creator: null, createdAt: '2026-10-01', likeCount: count - index,
  }));
  const loopCount = Math.ceil(8 / count) * count;
  const loopWidth = loopCount * 144;
  let viewportWidth = 600;
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
    const initialOffset = loopWidth - (viewportWidth - 120) / 2;
    expect(transform()).toBe(`translate3d(${-initialOffset}px, 0, 0)`);
    const titles = Array.from(container.querySelectorAll('h3')).map(title => title.textContent);
    expect(titles).toEqual(Array.from({ length: loopCount * 2 }, (_, index) => `Model ${index % count}`));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Scroll community models right"]')!.click());
    expect(transform()).toBe(`translate3d(${-((initialOffset + 144) % loopWidth)}px, 0, 0)`);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Scroll community models right"]')!.click());
    expect(transform()).toBe(`translate3d(${-((initialOffset + 288) % loopWidth)}px, 0, 0)`);
    viewportWidth = 390;
    act(() => resize());
    expect(transform()).toBe(`translate3d(${-(loopWidth - (390 - 120) / 2)}px, 0, 0)`);
  } finally {
    act(() => root.unmount());
    geometry.mockRestore();
    vi.unstubAllGlobals();
  }
  expect(disconnect).toHaveBeenCalledOnce();
});

it('positions the render-model chevron inside the select without intercepting input', () => {
  const markup = renderToStaticMarkup(<GenerationMethodSelector value="llm" llmModel={DEFAULT_LLM_MODEL} onChange={() => {}} />);
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
