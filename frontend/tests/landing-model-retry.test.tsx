import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useLandingModel } from '../src/hooks/useLandingModel';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
it('retains a waiting build after a status API error and recovers its completed model', async () => {
  vi.useFakeTimers();
  vi.spyOn(GetGenerationApiService, 'getGeneration')
    .mockRejectedValueOnce(new Error('API request failed: 503'))
    .mockResolvedValue({ generation_id: 'job', status: 'completed', mpd_url: '/ready.mpd' } as never);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'ready geometry' }));
  let state: ReturnType<typeof useLandingModel>;
  function Harness() { state = useLandingModel('owner', 'token', 'job'); return null; }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<Harness />));
    expect(state!.busy).toBe(true); expect(state!.error).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(state!.busy).toBe(false); expect(state!.model?.content).toBe('ready geometry'); expect(state!.error).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
