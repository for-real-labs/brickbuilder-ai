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
});

const button = (label: string) => Array.from(container.querySelectorAll('button')).find(element => element.textContent === label)!;

it('keeps edit actions visible while awaiting an ID, then saves a guest email outside the pet dialogue', async () => {
  await act(async () => root.render(<PendingEditActions generationId={null} onCancelled={vi.fn()} onStartNew={vi.fn()} />));
  expect(button('Email me').disabled).toBe(true);
  expect(button('Cancel').disabled).toBe(true);
  expect(button('Start new').disabled).toBe(true);

  await act(async () => root.render(<PendingEditActions key="edit" generationId="edit" onCancelled={vi.fn()} onStartNew={vi.fn()} />));
  act(() => button('Email me').click());
  const input = container.querySelector<HTMLInputElement>('input[type="email"]')!;
  expect(input).not.toBeNull();
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'builder@example.com');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('edit', 'builder@example.com');
  expect(button('Email set').disabled).toBe(true);
  expect(container.querySelector('input[type="email"]')).toBeNull();
  expect(posthog.capture).toHaveBeenCalledWith('generation_email_notification_subscribed', expect.objectContaining({ generation_id: 'edit', source: 'landing_edit_actions' }));
});

it('uses the account email for signed-in users and offers cancel and start new', async () => {
  auth.session = { user: { email: 'builder@example.com' } };
  const cancelled = vi.fn();
  const startNew = vi.fn();
  await act(async () => root.render(<PendingEditActions generationId="edit" onCancelled={cancelled} onStartNew={startNew} />));
  await act(async () => button('Email me').click());
  expect(GenerationEmailApi.subscribe).toHaveBeenCalledWith('edit', undefined);
  expect(container.querySelector('input[type="email"]')).toBeNull();
  await act(async () => button('Cancel').click());
  expect(GetGenerationApiService.cancelGeneration).toHaveBeenCalledExactlyOnceWith('edit');
  expect(cancelled).toHaveBeenCalledOnce();
  act(() => button('Start new').click());
  expect(startNew).toHaveBeenCalledOnce();
  expect(posthog.capture).toHaveBeenCalledWith('landing_edit_start_new_clicked', { generation_id: 'edit' });
});
