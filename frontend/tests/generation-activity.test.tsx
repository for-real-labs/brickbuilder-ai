import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGenerationActivity, GenerationActivity } from '../src/hooks/useGenerationActivity';
import { GenerationActivityList } from '../src/components/GenerationActivityList';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';
import posthog from 'posthog-js';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let activity: ReturnType<typeof useGenerationActivity>;
const open = vi.fn();
function Harness({ owner = 'user', enabled = true }: { owner?: string; enabled?: boolean }) {
  activity = useGenerationActivity(owner, owner === 'user' ? 'token' : undefined, enabled);
  return <GenerationActivityList {...activity} onOpen={open} onCancelled={id => {
    const row = activity.generations.find(row => row.id === id);
    if (row) activity.trackGeneration({ ...row, status: 'cancelled' });
  }} />;
}
const job = (id: string) => ({ id, prompt: `Build ${id}`, status: 'processing', endpoint: 'llmToBricks' });
const page = (generations: unknown[], has_more = false) => ({ generations, has_more, total_count: generations.length });

beforeEach(() => {
  vi.useFakeTimers();
  open.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('loads all pages of active generations and forwards auth and cancellation', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => page([job('one')], true) })
    .mockResolvedValueOnce({ ok: true, json: async () => page([job('two')]) });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  const jobs = await GetUserGenerationsApiService.getProcessingGenerations('token', controller.signal);
  expect(jobs.map(row => row.id)).toEqual(['one', 'two']);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ processing: true, limit: 50, offset: 1 });
  expect(fetch.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer token' }, signal: controller.signal });
});

it('restores every active job and retains completed and failed outcomes independently', async () => {
  const fetchJobs = vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations')
    .mockResolvedValueOnce([job('one'), job('two')] as never).mockResolvedValue([]);
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration').mockImplementation(async id => ({
    generation_id: id, status: id === 'one' ? 'completed' : 'failed', prompt: `Build ${id}`, error_message: 'Provider failed',
  } as never));
  await act(async () => root.render(<Harness />));
  expect(container.querySelectorAll('article')).toHaveLength(2);
  expect(container.textContent).toContain('2 in progress');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(get).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain('Ready to build');
  expect(container.textContent).toContain('Provider failed');
  expect(open).not.toHaveBeenCalled();
  act(() => container.querySelector('button')!.click());
  expect(open).toHaveBeenCalledWith('one');
  expect(posthog.capture).toHaveBeenCalledWith('landing_generation_opened', { generation_id: 'one', status: 'completed' });
  expect(fetchJobs).toHaveBeenCalledTimes(2);
});

it('recovers a job that completed while the page was closed', async () => {
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ status: 'completed', prompt: 'Castle' } as never);
  localStorage.setItem('pending_generations:v2:user', JSON.stringify([job('saved')]));
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('Castle');
  expect(container.textContent).toContain('View model');
});

it('cancels a card and preserves cancellation when an older refresh finishes', async () => {
  let finish!: (rows: never[]) => void;
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations')
    .mockResolvedValueOnce([job('stop')] as never)
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue();
  await act(async () => root.render(<Harness />));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await act(async () => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Generation cancelled');
  expect(container.querySelector('button')).toBeNull();
  await act(async () => finish([job('stop')] as never));
  expect(activity.generations[0].status).toBe('cancelled');
  expect(container.querySelector('.brick-build-scene')).toBeNull();
});

it.each([
  { preview_image_url: '/preview.png', processed_image_url: '/processed.png', external_image_url: '/reference.png', expected: '/preview.png' },
  { preview_image_url: '/preview.png', processed_image_url: null, external_image_url: null, expected: '/preview.png' },
  { preview_image_url: null, processed_image_url: '/processed.png', external_image_url: '/reference.png', expected: '/processed.png' },
  { preview_image_url: null, processed_image_url: null, external_image_url: '/reference.png', expected: '/reference.png' },
  { preview_image_url: null, processed_image_url: null, external_image_url: null, expected: '/existing.png' },
])('shows the best available image when a generation completes: $expected', async ({ expected, ...images }) => {
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations')
    .mockResolvedValueOnce([{ ...job('preview'), external_image_url: '/existing.png' }] as never)
    .mockResolvedValue([]);
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({
    generation_id: 'preview', status: 'completed', prompt: 'A limo', ...images,
  } as never);
  await act(async () => root.render(<Harness />));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  if (!images.preview_image_url) {
    expect(container.querySelector('[aria-label="Loading model preview"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  }
  expect(container.textContent).toContain('Ready to build');
  expect(container.querySelector('article img')?.getAttribute('src')).toBe(expected);
});

it('polls a completed generation until its delayed preview arrives', async () => {
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration')
    .mockResolvedValueOnce({ status: 'completed', prompt: 'A limo', preview_image_url: null } as never)
    .mockResolvedValue({ status: 'completed', prompt: 'A limo', preview_image_url: '/limo.png' } as never);
  localStorage.setItem('pending_generations:v2:user', JSON.stringify([job('delayed')]));
  await act(async () => root.render(<Harness />));
  expect(container.querySelector('[aria-label="Loading model preview"]')).not.toBeNull();
  expect(container.textContent).toContain('View model');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.querySelector('article img')?.getAttribute('src')).toBe('/limo.png');
  expect(container.querySelector('[aria-label="Loading model preview"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(get).toHaveBeenCalledTimes(2);
});

it('stops waiting after 60 seconds even when preview requests fail', async () => {
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  const get = vi.spyOn(GetGenerationApiService, 'getGeneration')
    .mockResolvedValueOnce({ status: 'completed', prompt: 'A limo' } as never)
    .mockRejectedValue(new Error('offline'));
  localStorage.setItem('pending_generations:v2:user', JSON.stringify([job('timeout')]));
  await act(async () => root.render(<Harness />));
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(container.querySelector('[aria-label="Loading model preview"]')).toBeNull();
  expect(container.textContent).toContain('Preview unavailable');
  expect(container.textContent).toContain('View model');
  const calls = get.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(get).toHaveBeenCalledTimes(calls);
});

it('keeps submitted jobs during refresh, retries network errors, and cancels on unmount', async () => {
  let finish!: (rows: never[]) => void;
  const fetchJobs = vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations')
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValue([]);
  vi.spyOn(GetGenerationApiService, 'getGeneration').mockResolvedValue({ status: 'processing' } as never);
  await act(async () => root.render(<Harness />));
  act(() => activity.trackGeneration(job('new')));
  await act(async () => finish([]));
  expect(container.textContent).toContain('Build new');
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.textContent).toContain('Retrying');
  expect(container.textContent).toContain('Build new');
  const signal = fetchJobs.mock.calls[0][1]!;
  act(() => root.unmount());
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetchJobs).toHaveBeenCalledTimes(2);
  root = createRoot(container);
});

it('waits for auth and clears another account’s cards', async () => {
  const fetchJobs = vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations')
    .mockResolvedValueOnce([job('private')] as never).mockResolvedValue([]);
  await act(async () => root.render(<Harness enabled={false} />));
  expect(fetchJobs).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness />));
  expect(container.textContent).toContain('Build private');
  await act(async () => root.render(<Harness owner="other" />));
  expect(container.textContent).not.toContain('Build private');
});

it('never restores legacy guest rows that may belong to another visitor', async () => {
  localStorage.setItem('pending_generations:anonymous', JSON.stringify([job('leaked')]));
  vi.spyOn(GetUserGenerationsApiService, 'getProcessingGenerations').mockResolvedValue([]);
  const status = vi.spyOn(GetGenerationApiService, 'getGeneration');
  await act(async () => root.render(<Harness owner="anonymous" />));
  expect(container.textContent).not.toContain('leaked');
  expect(activity.generations).toEqual([]);
  expect(status).not.toHaveBeenCalled();
});
