import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { CancelGenerationButton } from '../src/components/CancelGenerationButton';
import { GetGenerationApiService } from '../src/services/getGenerationApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

it('cancels once and only dismisses the build after the server accepts it', async () => {
  let finish!: () => void;
  const cancel = vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const done = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<CancelGenerationButton generationId="edit" isEdit onCancelled={done} />));
    expect(container.textContent).toContain('Cancel edit');
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('button')!.disabled).toBe(true);
    expect(done).not.toHaveBeenCalled();
    act(() => container.querySelector('button')!.click());
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(done).toHaveBeenCalledOnce();
    expect(posthog.capture).toHaveBeenCalledWith('generation_cancelled', { generation_id: 'edit', is_edit: true });
  } finally { act(() => root.unmount()); }
});

it('keeps the active build and allows a retry when cancellation fails', async () => {
  vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockRejectedValue(new Error('Already finished'));
  const done = vi.fn();
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() => root.render(<CancelGenerationButton generationId="job" onCancelled={done} />));
    await act(async () => container.querySelector('button')!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Already finished');
    expect(container.querySelector('button')!.disabled).toBe(false);
    expect(done).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); }
});
