import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LlmToBricksApiService } from '../src/services/llmToBricksApi';
import { LlmGenerationOutput } from '../src/components/LlmGenerationOutput';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it('speaks the pet failure message when a running build fails without displaying server details', async () => {
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockImplementation(async (_id, update) => {
    update({ text: 'Internal runtime diagnostics', status: 'failed', error: 'Cannot reach the Nova runtime' });
    return true;
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LlmGenerationOutput generationId="job" active />));
    const message = container.querySelector('[role="status"]');
    expect(message?.textContent).toBe('Woops! Something in the brickverse is down. Try again later');
    expect(message?.closest('.pet-chat-message')).not.toBeNull();
    expect(container.textContent).not.toContain('Nova runtime');
    expect(container.textContent).not.toContain('Internal runtime diagnostics');
    expect(container.textContent).not.toContain('reconnecting');
  } finally { act(() => root.unmount()); }
});

it('reads split SSE snapshots, CRLF and keep-alives, replacing replayed text', async () => {
  const encoder = new TextEncoder();
  const data = ': keep-alive\r\n\r\ndata: {"type":"output","text":"Build","status":"processing"}\r\n\r\ndata: {"type":"output","text":"Building a castle","status":"completed"}\n\n';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += 3) controller.enqueue(encoder.encode(data.slice(i, i + 3)));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })));
  const update = vi.fn();
  expect(await LlmToBricksApiService.watchOutput('job', update, new AbortController().signal)).toBe(true);
  expect(update.mock.calls.map(call => call[0].text)).toEqual(['Build', 'Building a castle']);
});

it('reconnects without duplicating notes and aborts observation on unmount', async () => {
  vi.useFakeTimers();
  const watch = vi.spyOn(LlmToBricksApiService, 'watchOutput')
    .mockImplementationOnce(async (_id, update) => { update({ text: 'Build', status: 'processing' }); return false; })
    .mockImplementationOnce(async (_id, update) => { update({ text: 'Building a castle', status: 'completed' }); return true; });
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<LlmGenerationOutput generationId="job" active />));
  expect(container.textContent).toContain('reconnecting');
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(container.textContent).toContain('Your build is ready');
  expect(container.textContent).not.toContain('BuildBuilding');
  expect(container.textContent).not.toContain('reconnecting');
  const signal = watch.mock.calls[0][2];
  act(() => root.unmount());
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(watch).toHaveBeenCalledTimes(2);
});

it('shows a reconnect state for a failed output connection without failing the job', async () => {
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockRejectedValue(new Error('offline'));
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(<LlmGenerationOutput generationId="job" active />));
  expect(container.textContent).toContain('Your build keeps running');
  expect(container.textContent).not.toContain('Generation Failed');
  act(() => root.unmount());
});

it('speaks successive generated summaries as buddy messages while new raw output arrives', async () => {
  let update: Parameters<typeof LlmToBricksApiService.watchOutput>[1];
  vi.spyOn(LlmToBricksApiService, 'watchOutput').mockImplementation(async (_id, onOutput, signal) => {
    update = onOutput;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(true)));
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(<LlmGenerationOutput generationId="job" active />));
    expect(container.textContent).not.toContain('Planning your brick build');
    expect(container.textContent).not.toContain('Preparing the brick design');
    act(() => update({ text: 'Long reasoning about the tail radius.', summary: 'Shaping the lizard tail', status: 'processing' }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('I’m shaping the lizard tail…');
    act(() => update({ text: 'Long reasoning about the tail radius. Next evaluate the feet.', summary: 'Shaping the lizard tail', status: 'processing' }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('I’m shaping the lizard tail…');
    act(() => update({ text: 'Long reasoning about the tail radius. Next evaluate the feet.', summary: 'Checking the feet', status: 'processing' }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('I’m checking the feet…');
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.className).toContain('build-thinking-shimmer');
    act(() => update({ text: 'Done', summary: 'Checking the feet', status: 'completed' }));
    expect(container.querySelector('[role="status"]')?.className).not.toContain('build-thinking-shimmer');
  } finally { act(() => root.unmount()); }
});
