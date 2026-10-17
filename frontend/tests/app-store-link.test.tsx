import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { AppStoreLink } from '../src/components/AppStoreLink';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

afterEach(() => {
  delete window.__BRICKBUILDER_NATIVE_APP__;
  vi.clearAllMocks();
});

describe('App Store download', () => {
  it.each(['header', 'footer'] as const)('links directly to the public listing and tracks %s attribution', placement => {
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      act(() => root.render(<AppStoreLink placement={placement} page="/image-to-lego" />));
      const link = container.querySelector('a')!;
      expect(link.href).toBe('https://apps.apple.com/app/brickbuilder-ai/id6815050463');
      expect(link.getAttribute('aria-label')).toBe('Download BrickBuilder AI for iOS on the App Store');
      expect(link.textContent).toContain('Download for iOS');
      expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      // Cancel jsdom navigation while exercising the real anchor's click handler.
      link.addEventListener('click', event => event.preventDefault());
      act(() => link.click());
      expect(posthog.capture).toHaveBeenCalledExactlyOnceWith('app_store_download_clicked', {
        page: '/image-to-lego', placement, platform: 'ios',
        destination: 'https://apps.apple.com/app/brickbuilder-ai/id6815050463',
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['ios', 'android'] as const)('omits the download prompt inside the native %s app', platform => {
    window.__BRICKBUILDER_NATIVE_APP__ = { platform, version: '1.0.1' };
    expect(renderToStaticMarkup(<AppStoreLink placement="footer" page="/" />)).toBe('');
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
