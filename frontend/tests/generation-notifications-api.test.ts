import { afterEach, expect, it, vi } from 'vitest';
import { GenerationNotificationsApi, NotificationApiError } from '../src/services/generationNotificationsApi';
import { authenticatedApiFetch } from '../src/services/apiFetch';
vi.mock('../src/services/apiFetch', () => ({ authenticatedApiFetch: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it('uses authenticated transport for feeds, read receipts, and edit recovery', async () => {
  vi.mocked(authenticatedApiFetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
  const controller = new AbortController();
  await GenerationNotificationsApi.list(controller.signal);
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.stringContaining('/generation-notifications'), { signal: controller.signal });
  await GenerationNotificationsApi.markViewed('model');
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.stringContaining('/generation/model/viewed'), { method: 'POST' });
  await GenerationNotificationsApi.markAllRead(['model']);
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.stringContaining('/generation-notifications/read'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ generation_ids: ['model'] }),
  });
  await GenerationNotificationsApi.latestEdit('source', controller.signal);
  expect(authenticatedApiFetch).toHaveBeenLastCalledWith(expect.stringContaining('/generation/source/latest-edit'), { signal: controller.signal });
});

it('preserves denied access status so community views do not retry read receipts forever', async () => {
  vi.mocked(authenticatedApiFetch).mockResolvedValue({ ok: false, status: 404 } as Response);
  await expect(GenerationNotificationsApi.markViewed('private')).rejects.toMatchObject({ status: 404 });
  await expect(GenerationNotificationsApi.list()).rejects.toBeInstanceOf(NotificationApiError);
});
