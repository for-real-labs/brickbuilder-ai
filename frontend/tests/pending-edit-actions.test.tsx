import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { PendingEditActions } from '../src/components/PendingEditActions';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';

const auth = vi.hoisted(() => ({ session: null as null | { user: { email: string } } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  auth.session = null;
  vi.spyOn(GenerationEmailApi, 'status').mockResolvedValue({ subscribed: false, email: null });
  vi.spyOn(GenerationEmailApi, 'subscribe').mockResolvedValue({ subscribed: true, email: 'builder@example.com' });
  vi.spyOn(GetGenerationApiService, 'cancelGeneration').mockResolvedValue(undefined);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const button = (label: string) => Array.from(container.querySelectorAll('button')).find(element => element.textContent === label)!;

it.each([true, false])('keeps the page open without promising email while awaiting a build ID, edit: %s', async isEdit => {
  await act(async () => root.render(<PendingEditActions generationId={null} isEdit={isEdit} onCancelled={vi.fn()} onStartNew={vi.fn()} />));
  expect(container.textContent).toContain('Keep this page open until your build starts.');
  expect(container.textContent).not.toContain('You can safely leave');
  expect(container.textContent).not.toContain('You will receive an email');
  expect(container.textContent).not.toContain('Building for');
  expect(button('Email me')).toBeUndefined();
  expect(container.querySelector('input')).toBeNull();
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  expect(button('Cancel').disabled).toBe(true);
  expect(button('Start new').disabled).toBe(true);
});

it('uses the account email for signed-in users and offers cancel and start new', async () => {
  auth.session = { user: { email: 'builder@example.com' } };
  const cancelled = vi.fn();
  const startNew = vi.fn();
  await act(async () => root.render(<PendingEditActions generationId="edit" onCancelled={cancelled} onStartNew={startNew} />));
  expect(GenerationEmailApi.subscribe).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="email"]')).toBeNull();
  await act(async () => button('Cancel').click());
  expect(GetGenerationApiService.cancelGeneration).toHaveBeenCalledExactlyOnceWith('edit');
  expect(cancelled).toHaveBeenCalledOnce();
  act(() => button('Start new').click());
  expect(startNew).toHaveBeenCalledOnce();
  expect(posthog.capture).toHaveBeenCalledWith('landing_edit_start_new_clicked', { generation_id: 'edit' });
});

it('uses generation actions and analytics for a new build', async () => {
  const startNew = vi.fn();
  await act(async () => root.render(<PendingEditActions generationId="new-build" isEdit={false}
    onCancelled={vi.fn()} onStartNew={startNew} />));
  expect(container.querySelector('[aria-label="Generation in progress actions"]')?.textContent).toContain("You will receive an email when it's ready.");
  act(() => button('Start new').click());
  expect(startNew).toHaveBeenCalledOnce();
  expect(posthog.capture).toHaveBeenCalledWith('landing_generation_start_new_clicked', { generation_id: 'new-build' });
});

it('shows the active build duration and saved notification address', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T18:01:00Z'));
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true, email: 'saved@example.com' });
  await act(async () => root.render(<PendingEditActions generationId="new-build" isEdit={false}
    startedAt="2026-10-19T18:00:00Z" onCancelled={vi.fn()} onStartNew={vi.fn()} />));
  expect(container.textContent).toContain('Building for 1m 0s');
  expect(container.textContent).toContain("You will receive an email when it's ready.");
  expect(button('Email set')).toBeUndefined();
});
