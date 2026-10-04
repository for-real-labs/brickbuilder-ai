import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { NovaBuilderOptions } from '../src/components/NovaBuilderOptions';
import { DEFAULT_NOVA_OPTIONS } from '../src/services/novaToBricksApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

describe('Nova builder controls', () => {
  it('describes the set-building flow and keeps local subscription choices on localhost', () => {
    const render = (local: boolean) => renderToStaticMarkup(<NovaBuilderOptions options={DEFAULT_NOVA_OPTIONS} onChange={() => {}} local={local} />);
    expect(render(true)).toContain('Nova full set agent');
    expect(render(true)).toContain('Nova’s own agent');
    expect(render(true)).toContain('Signed in to Claude');
    expect(render(true)).toContain('Project API key');
    expect(render(false)).not.toContain('Signed in to Claude');
    expect(render(false)).not.toContain('Provider connection');
    expect(render(true)).toContain('grid-cols-1');
    expect(render(true)).toContain('sm:grid-cols-2');
  });

  it('changes provider, model, account connection, with Nova runtime settings with analytics', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const change = vi.fn();
    const select = (id: string, value: string) => act(() => {
      const field = container.querySelector<HTMLSelectElement>(`#${id}`)!;
      field.value = value; field.dispatchEvent(new Event('change', { bubbles: true }));
    });
    try {
      act(() => root.render(<NovaBuilderOptions options={DEFAULT_NOVA_OPTIONS} onChange={change} local />));
      select('nova-provider', 'openai');
      expect(change).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.6-sol' }));
      expect(posthog.capture).toHaveBeenCalledWith('landing_nova_provider_selected', { provider: 'openai' });
      act(() => root.render(<NovaBuilderOptions options={{ ...DEFAULT_NOVA_OPTIONS, model: 'gpt-5.6-sol' }} onChange={change} local />));
      select('nova-model', 'gpt-5.5');
      expect(change).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-5.5' }));
      select('nova-connection', 'native');
      expect(change).toHaveBeenCalledWith(expect.objectContaining({ authMode: 'native' }));
      expect(container.querySelector('#nova-max-parts')).toBeNull();
      expect(container.textContent).toContain('isolated workspace');
    } finally { act(() => root.unmount()); }
  });
});
