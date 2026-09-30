import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { GenerationNotificationsProvider, useGenerationNotifications } from '../src/contexts/GenerationNotificationsContext';
import { NotificationMenu } from '../src/components/NotificationMenu';
import { GenerationNotificationsApi } from '../src/services/generationNotificationsApi';

let auth = { user: { id: 'owner' }, session: { access_token: 'token' }, loading: false };
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
const ready = (id: string, seen = false) => ({ id, prompt: 'Tower', status: 'completed', seen, updated_at: new Date().toISOString(), is_edit: true });
let feed: ReturnType<typeof useGenerationNotifications>;
function Harness() { feed = useGenerationNotifications(); return <NotificationMenu />; }
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers();
  auth = { user: { id: 'owner' }, session: { access_token: 'token' }, loading: false };
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => { root.render(<MemoryRouter><GenerationNotificationsProvider><Harness /></GenerationNotificationsProvider></MemoryRouter>); });

it('shows unread badges, keeps dropdown links unread, and clears only on a model read receipt', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('done')], active: [], unread_count: 1 });
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockResolvedValue({});
  await render();
  expect(container.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('1');
  act(() => container.querySelector('button')!.click());
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/generated-model?id=done&exact=1');
  expect(mark).not.toHaveBeenCalled();
  await act(async () => { await feed.markViewed('done'); });
  expect(mark).toHaveBeenCalledWith('done');
  expect(container.querySelector('[data-testid="notification-badge"]')).toBeNull();
  expect(container.querySelector('a')).not.toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(container.querySelector('section')).toBeNull();
});

it('notifies once when a tracked edit completes and does not spam historical completions', async () => {
  const native = vi.fn(function() { return { close: vi.fn() }; });
  Object.assign(native, { permission: 'granted', requestPermission: vi.fn() });
  vi.stubGlobal('Notification', native);
  vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({ notifications: [ready('old')], active: [{ ...ready('edit'), status: 'queued' }], unread_count: 1 })
    .mockResolvedValue({ notifications: [ready('edit'), ready('old')], active: [], unread_count: 2 });
  await render();
  expect(native).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(native).toHaveBeenCalledTimes(1);
  expect(native).toHaveBeenCalledWith('Your model edit is ready', expect.objectContaining({ tag: 'brickbuilder:edit' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(native).toHaveBeenCalledTimes(1);
});

it('asks permission only after the explicit enable action and isolates account changes', async () => {
  const requestPermission = vi.fn().mockResolvedValue('granted');
  vi.stubGlobal('Notification', { permission: 'default', requestPermission });
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('private')], active: [], unread_count: 1 });
  await render();
  act(() => container.querySelector('button')!.click());
  expect(requestPermission).not.toHaveBeenCalled();
  await act(async () => { (Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Enable browser notifications')!).click(); });
  expect(requestPermission).toHaveBeenCalledOnce();
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({ notifications: [], active: [], unread_count: 0 });
  auth = { user: { id: 'another' }, session: { access_token: 'another-token' }, loading: false };
  await render();
  expect(container.textContent).not.toContain('Tower');
  expect(container.querySelector('[data-testid="notification-badge"]')).toBeNull();
});

it('keeps in-progress models linked after navigation and retries notification polling failures', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ notifications: [], active: [{ ...ready('running'), status: 'processing' }], unread_count: 0 });
  await render();
  expect(feed.error).toContain('Retrying');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  act(() => container.querySelector('button')!.click());
  expect(container.textContent).toContain('Model in progress');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/generated-model?id=running&exact=1');
  expect(feed.error).toBeNull();
});
