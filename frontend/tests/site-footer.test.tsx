import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { SiteFooter } from '../src/components/SiteFooter';
import { VOXEL_CONVERTERS } from '../src/voxelConverters';
import { IMAGE_MODEL_PAGES } from '../src/imageModelPages';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

it('keeps support and legal links visible and all converter links in a collapsed crawlable disclosure', () => {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<MemoryRouter initialEntries={['/settings']}><SiteFooter /></MemoryRouter>);
  const tools = host.querySelector('details')!;
  expect(tools.open).toBe(false);
  expect(tools.querySelector('summary')?.textContent).toBe('Tools & converters');
  for (const href of ['/privacy', '/terms', 'mailto:support@brickbuilder.ai', '/blog', '/community']) {
    expect(host.querySelector(`a[href="${href}"]`)).not.toBeNull();
    expect(tools.querySelector(`a[href="${href}"]`)).toBeNull();
  }
  for (const path of ['/use-ai-to-edit-ldraw', '/image-to-lego', '/photo-to-lego', '/glb-to-lego', '/obj-to-lego', '/obj-to-glb', '/glb-to-obj', ...VOXEL_CONVERTERS.map(item => item.path), ...IMAGE_MODEL_PAGES.map(item => item.path)]) {
    expect(tools.querySelector(`a[href="${path}"]`)).not.toBeNull();
  }
});

it('tracks opening and closing the tools disclosure', () => {
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    act(() => root.render(<MemoryRouter initialEntries={['/settings']}><SiteFooter /></MemoryRouter>));
    const tools = host.querySelector('details')!;
    for (const expanded of [true, false]) {
      act(() => { tools.open = expanded; tools.dispatchEvent(new Event('toggle')); });
      expect(posthog.capture).toHaveBeenLastCalledWith('footer_tools_toggled', { expanded, page: '/settings' });
    }
  } finally { act(() => root.unmount()); }
});
