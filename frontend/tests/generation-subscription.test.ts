import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '../src/services/apiFetch';
import { GENERATION_SUBSCRIPTION_EVENT } from '../src/utils/generationSubscription';

afterEach(() => vi.restoreAllMocks());

it('opens the subscription popup only for a subscription rejection, not for a credit shortage or a file tool', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const detail = { code: 'BB_SUBSCRIPTION_REQUIRED' };
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ detail }, { status: 402 }))
    .mockResolvedValueOnce(Response.json({ detail: 'You have used your available credits.' }, { status: 402 }))
    .mockResolvedValueOnce(Response.json({ ok: true }));
  const submit = (path: string) => apiFetch(`https://example.test/${path}`, { method: 'POST' });

  await expect(submit('llmToBricks/stream')).rejects.toThrow('Subscribe to generate');
  await expect(submit('novaToBricks')).resolves.toMatchObject({ status: 402 });
  await expect(submit('objToBricks')).resolves.toMatchObject({ status: 200 });
  expect(dispatch.mock.calls.map(([event]) => event.type)).toEqual([
    GENERATION_SUBSCRIPTION_EVENT, 'brickbuilder:credits-required',
  ]);
});
