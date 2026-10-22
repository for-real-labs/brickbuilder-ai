import { afterEach, expect, it, vi } from 'vitest';
import { localizeGenerationLimit } from '../src/services/generationLimit';
import { NovaToBricksApiService, DEFAULT_NOVA_OPTIONS } from '../src/services/novaToBricksApi';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const limitResponse = () => new Response(JSON.stringify({
  detail: 'You have reached the daily limit of 30 generations. Please wait until October 22, 2026 at 00:00 UTC to generate again.',
}), { status: 429, headers: { 'Retry-After': 'Thu, 22 Oct 2026 00:00:00 GMT', 'Content-Type': 'application/json' } });

it('shows the reset date and time in the browser timezone through the generation service', async () => {
  const formatter = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((locale, options) =>
    new formatter('en-US', { ...options, timeZone: 'America/Chicago' }));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(limitResponse()));
  await expect(NovaToBricksApiService.generate({ ...DEFAULT_NOVA_OPTIONS, prompt: 'castle' }, 'token'))
    .rejects.toThrow('Please wait until October 21, 2026 at 7:00 PM CDT to generate again.');
});

it.each([
  new Response('ok'),
  new Response('Other limit', { status: 429 }),
  new Response('not json', { status: 429, headers: { 'Retry-After': 'Thu, 22 Oct 2026 00:00:00 GMT' } }),
  new Response('fallback', { status: 429, headers: { 'Retry-After': 'invalid' } }),
  new Response(JSON.stringify({ detail: 'Concurrency limit' }), { status: 429, headers: { 'Retry-After': 'Thu, 22 Oct 2026 00:00:00 GMT' } }),
])('preserves unrelated errors and responses without consuming their bodies', async response => {
  expect(await localizeGenerationLimit(response)).toBe(response);
  expect(response.bodyUsed).toBe(false);
});

it('preserves a restricted account quota in localized and pet messages', async () => {
  const { buildFailureMessage } = await import('../src/utils/buildProgress');
  const response = new Response(JSON.stringify({
    detail: 'You have reached the daily limit of 5 generations. Please wait until October 22, 2026 at 00:00 UTC to generate again.',
  }), { status: 429, headers: { 'Retry-After': 'Thu, 22 Oct 2026 00:00:00 GMT' } });
  const localized = await localizeGenerationLimit(response);
  const { detail } = await localized.json();
  expect(detail).toContain('daily limit of 5 generations.');
  expect(buildFailureMessage(new Error(detail))).toBe(detail);
});
