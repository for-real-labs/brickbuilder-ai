import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startPolling } from '../src/utils/polling';

let visibility = 'visible';
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility as DocumentVisibilityState);
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

it('never overlaps slow requests, including focus and visibility events', async () => {
  let finish!: () => void;
  const task = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  stop = startPolling(task, { intervalMs: 5_000 }).stop;
  await vi.advanceTimersByTimeAsync(10_000);
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
  expect(task).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(2);
  finish();
});

it('pauses hidden tabs and refreshes immediately when they become visible', async () => {
  const task = vi.fn(async () => 60_000);
  stop = startPolling(task, { intervalMs: 5_000 }).stop;
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(task).toHaveBeenCalledTimes(1);
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(task).toHaveBeenCalledTimes(1);
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  expect(task).toHaveBeenCalledTimes(2);
});

it('backs off failing requests and resets the delay after recovery', async () => {
  const task = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  stop = startPolling(task, { intervalMs: 5_000 }).stop;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(task).toHaveBeenCalledTimes(3);
});

it('aborts pending requests and removes listeners when stopped', async () => {
  let signal!: AbortSignal;
  let finish!: () => void;
  const task = vi.fn((value: AbortSignal) => {
    signal = value;
    return new Promise<void>(resolve => { finish = resolve; });
  });
  stop = startPolling(task, { intervalMs: 5_000 }).stop;
  expect(signal.aborted).toBe(false);
  stop();
  expect(signal.aborted).toBe(true);
  finish();
  window.dispatchEvent(new Event('focus'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(task).toHaveBeenCalledOnce();
});

it('allows opted-in background polling and bounds stalled network requests', async () => {
  visibility = 'hidden';
  let signal!: AbortSignal;
  let reject!: (error: Error) => void;
  const task = vi.fn((value: AbortSignal) => {
    signal = value;
    return new Promise<void>((_resolve, fail) => { reject = fail; });
  });
  stop = startPolling(task, { intervalMs: 5_000, allowBackground: () => true }).stop;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signal.aborted).toBe(true);
  expect(task).toHaveBeenCalledOnce();
  reject(new DOMException('Timed out', 'AbortError'));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(task).toHaveBeenCalledTimes(2);
  reject(new Error('stopped'));
});
