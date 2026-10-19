import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { CreateNewBuildsPrompt } from '../src/components/CreateNewBuildsPrompt';
import { GenerationEmailApi } from '../src/services/generationEmailApi';
import { GetGenerationApiService } from '../src/services/getGenerationApi';

const auth = vi.hoisted(() => ({ session: null as null | { user: { email: string } } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const cancelled = vi.fn();
const render = () => <CreateNewBuildsPrompt
  processing={[{ id: 'working', prompt: 'Rocket', status: 'processing', createdAt: '2026-10-19T18:00:00Z' }]}
  completed={[]} page={0} pageSize={5} onBack={vi.fn()} onView={vi.fn()} onMore={vi.fn()} onCancelled={cancelled} />;
const button = (label: string) => [...container.querySelectorAll('button')].find(element => element.textContent === label)!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-19T18:01:00Z'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  auth.session = null;
  cancelled.mockReset();
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

it('shows elapsed time, saves a guest email, and cancels the build', async () => {
  await act(async () => root.render(render()));
  expect(container.textContent).toContain('Building for 1m 0s');
  act(() => vi.advanceTimersByTime(5_000));
  expect(container.textContent).toContain('Building for 1m 5s');
  act(() => button('Email when ready').click());
  const input = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'builder@example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('working', 'builder@example.com');
  expect(container.textContent).toContain('Email will be sent to builder@example.com when ready.');
  expect(button('Email when ready')).toBeUndefined();
  await act(async () => button('Cancel').click());
  expect(GetGenerationApiService.cancelGeneration).toHaveBeenCalledWith('working');
  expect(cancelled).toHaveBeenCalledWith('working');
  expect(posthog.capture).toHaveBeenCalledWith('generation_email_notification_subscribed', expect.objectContaining({
    generation_id: 'working', source: 'landing_builds_dialogue',
  }));
});

it('shows the existing recipient instead of another email button', async () => {
  vi.mocked(GenerationEmailApi.status).mockResolvedValue({ subscribed: true, email: 'saved@example.com' });
  await act(async () => root.render(render()));
  expect(container.textContent).toContain('Email will be sent to saved@example.com when ready.');
  expect(button('Email when ready')).toBeUndefined();
  expect(button('Cancel')).not.toBeUndefined();
});

it('uses the signed in account email', async () => {
  auth.session = { user: { email: 'member@example.com' } };
  await act(async () => root.render(render()));
  await act(async () => button('Email when ready').click());
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('working', undefined);
  expect(container.textContent).toContain('Email will be sent to builder@example.com when ready.');
});
