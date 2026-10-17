import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Link, MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { MobileAppBanner } from '../src/components/MobileAppBanner';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';
const CHROME = `${IPHONE} CriOS/130.0.0 Mobile/15E148 Safari/604.1`;
const SAFARI = `${IPHONE} Version/18.0 Mobile/15E148 Safari/604.1`;
const KEY = 'brickbuilder_app_banner_dismissed_until';
let container: HTMLDivElement;
let root: Root;

function browser(userAgent = CHROME, options = {}) {
  vi.stubGlobal('navigator', { userAgent, platform: 'iPhone', maxTouchPoints: 5, standalone: false, ...options });
}

function render(path = '/', visit = 'initial') {
  act(() => root.render(<MemoryRouter key={visit} initialEntries={[path]}>
    <MobileAppBanner />
    <Link to="/community">Explore community</Link>
  </MemoryRouter>));
}

beforeEach(() => {
  browser();
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.__BRICKBUILDER_NATIVE_APP__;
  vi.unstubAllGlobals();
});

describe('mobile app download prompt', () => {
  it.each([
    SAFARI,
    CHROME,
    `${IPHONE} FxiOS/130.0 Mobile/15E148 Safari/605.1.15`,
    `${IPHONE} Mobile/15E148 Instagram 350.0`,
    `${IPHONE} Version/18.0 Mobile/15E148 Safari/604.1 [FBAN/FBIOS;FBAV/480.0]`,
  ])('prompts iOS visitors consistently across browsers: %s', userAgent => {
    browser(userAgent);
    render('/image-to-lego');
    const banner = container.querySelector('aside')!;
    expect(banner.hasAttribute('data-app-banner')).toBe(true);
    expect(banner.getAttribute('aria-label')).toBe('Get the BrickBuilder AI app');
    expect(banner.textContent).toContain('Free on the App Store.');
    const link = banner.querySelector('a')!;
    expect(link.href).toBe('https://apps.apple.com/app/brickbuilder-ai/id6815050463');
    expect(posthog.capture).toHaveBeenCalledWith('app_store_banner_shown', { page: '/image-to-lego', platform: 'ios' });
    link.addEventListener('click', event => event.preventDefault());
    act(() => link.click());
    expect(posthog.capture).toHaveBeenCalledWith('app_store_download_clicked', {
      page: '/image-to-lego', placement: 'mobile_banner', platform: 'ios', destination: link.href,
    });
  });

  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/18.0 Safari/605.1.15', { platform: 'MacIntel', maxTouchPoints: 0 }],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', { platform: 'Linux armv8l' }],
  ])('does not prompt desktop or Android visitors: %s', (userAgent, options) => {
    browser(userAgent, options);
    render();
    expect(container.querySelector('aside')).toBeNull();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it.each(['Version/18.0', 'CriOS/130.0'])('recognizes iPad browsers using a desktop user agent: %s', browserVersion => {
    browser(`Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15 ${browserVersion} Safari/605.1.15`, { platform: 'MacIntel' });
    render();
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it.each(['native', 'standalone', 'display-mode'])('does not prompt inside an existing %s app', mode => {
    if (mode === 'native') window.__BRICKBUILDER_NATIVE_APP__ = { platform: 'ios', version: '1.0.1' };
    if (mode === 'standalone') browser(CHROME, { standalone: true });
    if (mode === 'display-mode') vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }));
    render();
    expect(container.querySelector('aside')).toBeNull();
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it.each([SAFARI, CHROME])('remembers dismissal for seven days, including subsequent visits: %s', userAgent => {
    browser(userAgent);
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    render();
    act(() => container.querySelector<HTMLButtonElement>('aside button')!.click());
    expect(container.querySelector('aside')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe(String(Date.now() + 7 * 24 * 60 * 60 * 1000));
    expect(posthog.capture).toHaveBeenCalledWith('app_store_banner_dismissed', { page: '/', platform: 'ios' });
    render('/', 'next-visit');
    expect(container.querySelector('aside')).toBeNull();
  });

  it.each(['expired', 'invalid'])('shows the prompt again after an %s dismissal', state => {
    localStorage.setItem(KEY, state === 'expired' ? String(Date.now() - 1) : 'invalid');
    render();
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('can be dismissed for the visit when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Blocked'); });
    render();
    act(() => container.querySelector<HTMLButtonElement>('aside button')!.click());
    act(() => container.querySelector<HTMLAnchorElement>('a')!.click());
    expect(container.querySelector('aside')).toBeNull();
  });

  it.each(['/login', '/signup', '/oauth/consent', '/order', '/success'])('keeps the prompt out of %s', path => {
    render(path);
    expect(container.querySelector('aside')).toBeNull();
    expect(posthog.capture).not.toHaveBeenCalled();
    act(() => container.querySelector<HTMLAnchorElement>('a')!.click());
    expect(container.querySelector('aside')).not.toBeNull();
    expect(posthog.capture).toHaveBeenCalledWith('app_store_banner_shown', { page: '/community', platform: 'ios' });
  });
});
