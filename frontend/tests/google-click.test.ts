import { afterEach, expect, it } from 'vitest';
import { googleClick, landingClick, saveClick } from '../src/utils/googleClick';

afterEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });
it('only attributes an ad landing after permission and expires after 90 days', () => {
  history.replaceState(null, '', '/?gclid=ABC-123');
  expect(googleClick()).toBeUndefined();
  saveClick(landingClick());
  expect(googleClick()).toBe('ABC-123');
  expect(googleClick(Date.now() + 90 * 86400000)).toBeUndefined();
});
