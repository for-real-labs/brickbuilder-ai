import { expect, it } from 'vitest';
import { isBuildFromToday } from '../src/utils/recentBuilds';

it('includes only builds from the current local calendar day, not a rolling 24-hour window', () => {
  const now = new Date(2026, 9, 24, 0, 30);
  expect(isBuildFromToday(new Date(2026, 9, 24, 0, 5).toISOString(), now)).toBe(true);
  expect(isBuildFromToday(new Date(2026, 9, 23, 23, 55).toISOString(), now)).toBe(false);
  expect(isBuildFromToday(new Date(2026, 9, 24, 1).toISOString(), now)).toBe(false);
});

it('ignores missing and invalid timestamps', () => {
  for (const timestamp of [null, undefined, '', 'not a date']) expect(isBuildFromToday(timestamp)).toBe(false);
});
