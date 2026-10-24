import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it.each([undefined, 'https://public.example/generation-stats'])('loads stats from the configured endpoint (%s)', async override => {
  vi.stubEnv('VITE_API_MODE', 'local');
  vi.stubEnv('VITE_LOCAL_API_URL', 'http://127.0.0.1:8002');
  vi.stubEnv('VITE_GENERATION_STATS_API_URL', override);
  const stats = { generation_count: 120, brick_count: 45000 };
  const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => stats });
  vi.stubGlobal('fetch', fetch);
  const { GetGenerationStatsApiService } = await import('../src/services/getGenerationStatsApi');
  const signal = new AbortController().signal;
  expect(await GetGenerationStatsApiService.getGenerationStats(signal)).toEqual(stats);
  expect(fetch).toHaveBeenCalledWith(override || 'http://127.0.0.1:8002/generation-stats', { signal });
});
