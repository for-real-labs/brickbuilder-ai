import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { metaClick, metaLandingClick, saveMetaClick } from '../src/utils/metaClick';

beforeEach(() => vi.stubEnv('VITE_META_AD_MEASUREMENT', 'true'));
afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('retains a Meta ad click only after permission', () => {
  const clicked_at = Date.now();
  const click = metaLandingClick('?fbclid=meta_ad-123', clicked_at);
  expect(click).toEqual({ id: 'meta_ad-123', clicked_at });
  expect(metaClick()).toBeUndefined();
  saveMetaClick(click);
  expect(metaClick()).toEqual(click);
  saveMetaClick();
  expect(metaClick()).toBeUndefined();
});

it('does not use expired, invalid, or non-Meta click IDs', () => {
  const now = Date.now();
  saveMetaClick(metaLandingClick('?fbclid=valid_click', now));
  expect(metaClick(now + 7 * 86400000)).toBeUndefined();
  expect(metaLandingClick('?fbclid=%2Fother')).toBeUndefined();
  expect(metaLandingClick('?gclid=google_only')).toBeUndefined();
});

it('respects browser privacy signals and removes an earlier click', () => {
  saveMetaClick(metaLandingClick('?fbclid=valid_click'));
  vi.stubGlobal('navigator', { globalPrivacyControl: true });
  expect(metaLandingClick('?fbclid=new_click')).toBeUndefined();
  expect(metaClick()).toBeUndefined();
  vi.unstubAllGlobals();
  expect(metaClick()).toBeUndefined();
});

it('stays disabled without deployment configuration', () => {
  vi.stubEnv('VITE_META_AD_MEASUREMENT', 'false');
  expect(metaLandingClick('?fbclid=valid_click')).toBeUndefined();
});
