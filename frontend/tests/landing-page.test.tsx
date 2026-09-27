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

vi.mock('../src/contexts/AuthContext', () => ({
  useAuth: () => ({
    session: null,
    loading: false,
    user: null,
    isSupabaseConfigured: false,
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

import LandingPage, { DEFAULT_GENERATION_METHOD, DEFAULT_THREE_D_MODEL, GenerationMethodSelector } from '../src/pages/LandingPage';
import { DEFAULT_LLM_MODEL } from '../src/services/llmToBricksApi';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';
import { GetGenerationStatsApiService } from '../src/services/getGenerationStatsApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import { GetCommunityGenerationsApiService } from '../src/services/getCommunityGenerationsApi';

describe('LandingPage', () => {
  it('starts LLM jobs in the background and allows another submission while they run', async () => {
    vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
    vi.spyOn(GetGenerationStatsApiService, 'getGenerationStats').mockResolvedValue({ generation_count: 12, brick_count: 400 });
    const start = vi.spyOn(LlmToBricksApiService, 'generate')
      .mockResolvedValueOnce({ generation_id: 'one', message: 'Started' })
      .mockResolvedValueOnce({ generation_id: 'two', message: 'Started' });
    const stream = vi.spyOn(LlmToBricksApiService, 'generateStream');
    const poll = vi.spyOn(GetGenerationApiService, 'pollUntilComplete');
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
    } finally {
      act(() => root.unmount());
      container.remove();
    }
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
      expect(container.textContent).toContain('20');
      expect(container.textContent).toContain('Sep 26, 2026');
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
