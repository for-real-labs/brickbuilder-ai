import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiFetch';
vi.mock('../src/utils/aiConsent', () => ({ requiresAiConsent: () => false }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('opens the credit flow on a generation 402 and refreshes the balance after admission', async () => {
  const events = vi.spyOn(window, 'dispatchEvent');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('No credits', { status: 402 })).mockResolvedValueOnce(new Response('ok')));
  const rejected = await apiFetch('https://api.example.test/novaToBricks', { method: 'POST' });
  expect(rejected.status).toBe(402);
  expect(events.mock.calls.map(([event]) => event.type)).toContain('brickbuilder:credits-required');
  await apiFetch('https://api.example.test/llmToBricks', { method: 'POST' });
  expect(events.mock.calls.map(([event]) => event.type)).toContain('brickbuilder:credits-changed');
});

it('does not open a generation upsell for unrelated billing errors', async () => {
  const events = vi.spyOn(window, 'dispatchEvent');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 402 })));
  await apiFetch('https://api.example.test/billing/checkout', { method: 'POST' });
  expect(events).not.toHaveBeenCalled();
});
