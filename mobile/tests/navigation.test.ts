import { describe, expect, it } from 'vitest';

import {
  buildAppUrl,
  classifyNavigation,
  getExternalLinkHostname,
} from '../src/navigation';

const APP_URL = 'https://brickbuilder.ai';

describe('mobile navigation policy', () => {
  it('builds routes on the configured app origin', () => {
    expect(buildAppUrl(APP_URL, '/dashboard')).toBe(
      'https://brickbuilder.ai/dashboard',
    );
  });

  it('keeps app, Stripe, and Supabase flows in the web view', () => {
    expect(classifyNavigation(`${APP_URL}/generated-model?id=1`, APP_URL)).toBe(
      'webview',
    );
    expect(
      classifyNavigation('https://checkout.stripe.com/c/pay/test', APP_URL),
    ).toBe('webview');
    expect(
      classifyNavigation('https://project.supabase.co/auth/v1/callback', APP_URL),
    ).toBe('webview');
  });

  it('allows the Stripe network frame only as embedded HTTPS content', () => {
    const frame = 'https://m.stripe.network/inner.html#url=https%3A%2F%2Fbrickbuilder.ai%2Forder';
    expect(classifyNavigation(frame, APP_URL, false)).toBe('webview');
    expect(classifyNavigation(frame, APP_URL, true)).toBe('blocked');
    expect(classifyNavigation(frame, APP_URL)).toBe('blocked');
    expect(classifyNavigation('http://m.stripe.network/inner.html', APP_URL, false)).toBe('blocked');
    expect(classifyNavigation('https://m.stripe.network.example.com/inner.html', APP_URL, false)).toBe('external');
  });

  it('opens ordinary HTTPS and mail links outside the app', () => {
    expect(classifyNavigation('https://github.com/openai', APP_URL)).toBe(
      'external',
    );
    expect(classifyNavigation('mailto:support@brickbuilder.ai', APP_URL)).toBe(
      'external',
    );
  });

  it('blocks unsafe URL schemes', () => {
    expect(classifyNavigation('javascript:alert(1)', APP_URL)).toBe('blocked');
    expect(classifyNavigation('not a url', APP_URL)).toBe('blocked');
  });

  it('extracts only valid external hostnames', () => {
    expect(getExternalLinkHostname('https://github.com/example')).toBe(
      'github.com',
    );
    expect(getExternalLinkHostname('mailto:test@example.com')).toBeNull();
  });
});
