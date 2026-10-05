import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { GenerationNotificationsProvider, useGenerationNotifications } from '../src/contexts/GenerationNotificationsContext';
import { NotificationMenu } from '../src/components/NotificationMenu';
import { GenerationNotificationsApi } from '../src/services/generationNotificationsApi';
import UserDashboard from '../src/pages/UserDashboard';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';

let auth = { user: { id: 'owner' }, session: { access_token: 'token' }, loading: false };
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/components/SEO', () => ({ SEO: () => null }));
vi.mock('../src/components/SiteFooter', () => ({ SiteFooter: () => null }));
const ready = (id: string, seen = false) => ({ id, prompt: 'Tower', status: 'completed', seen, updated_at: new Date().toISOString(), is_edit: true });
let feed: ReturnType<typeof useGenerationNotifications>;
function Harness() {
  feed = useGenerationNotifications();
  const location = useLocation();
  return <><NotificationMenu /><output>{location.pathname}{location.search}</output></>;
}
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

it('marks all unread completions as read only on explicit action, retaining model links and active builds', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({
    notifications: [ready('first'), ready('second'), ready('already', true)],
    active: [{ ...ready('running'), status: 'processing' }], unread_count: 2,
  });
  const markAll = vi.spyOn(GenerationNotificationsApi, 'markAllRead').mockResolvedValue({ seen_ids: ['first', 'second'] });
  await render();
  await act(async () => container.querySelector('button')!.click());
  expect(markAll).not.toHaveBeenCalled();
  const action = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Mark all as read')!;
  await act(async () => action().click());
  expect(markAll).toHaveBeenCalledWith(['first', 'second']);
  expect(container.querySelector('[data-testid="notification-badge"]')).toBeNull();
  expect(container.querySelectorAll('a')).toHaveLength(4);
  expect(container.textContent).toContain('Model in progress');
  expect(action().disabled).toBe(true);
  // An older in-flight feed response must not revive acknowledged badges.
  await act(async () => { await feed.refresh(); });
  expect(container.querySelector('[data-testid="notification-badge"]')).toBeNull();
});

it('preserves unread notifications on failure and lets the user retry', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('done')], active: [], unread_count: 1 });
  vi.spyOn(GenerationNotificationsApi, 'markAllRead').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ seen_ids: ['done'] });
  await render();
  await act(async () => container.querySelector('button')!.click());
  const action = () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Mark all as read')!;
  await act(async () => action().click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please try again');
  expect(container.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('1');
  expect(action().disabled).toBe(false);
  await act(async () => action().click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-testid="notification-badge"]')).toBeNull();
});

it('does not mark new arrivals or another account read while a bulk request is pending', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('old')], active: [], unread_count: 1 });
  let finish!: (value: { seen_ids: string[] }) => void;
  vi.spyOn(GenerationNotificationsApi, 'markAllRead').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  let pending!: Promise<void>;
  act(() => { pending = feed.markAllRead(); });
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({ notifications: [ready('new'), ready('old')], active: [], unread_count: 2 });
  await act(async () => { feed.refresh(); });
  await act(async () => { finish({ seen_ids: ['old'] }); await pending; });
  expect(feed.unread_count).toBe(1);
  expect(feed.notifications.find(model => model.id === 'new')?.seen).toBe(false);
  act(() => { pending = feed.markAllRead(); });
  auth = { user: { id: 'another' }, session: { access_token: 'another-token' }, loading: false };
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({ notifications: [ready('new')], active: [], unread_count: 1 });
  await render();
  await act(async () => { finish({ seen_ids: ['new'] }); await pending; });
  expect(feed.unread_count).toBe(1);
  expect(feed.notifications[0].seen).toBe(false);
});

it('shows the notification bell in the dashboard header with its unread count', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({notifications: [ready('done')], active: [], unread_count: 1});
  vi.spyOn(GetUserGenerationsApiService, 'getUserGenerations').mockResolvedValue({
    generations: [], total_count: 0, total_user_generations: 0, all_orders: [], has_more: false,
  });
  await act(async () => root.render(<MemoryRouter initialEntries={['/dashboard']}>
    <GenerationNotificationsProvider><UserDashboard /></GenerationNotificationsProvider>
  </MemoryRouter>));
  const bell = container.querySelector('header [aria-label="Notifications, 1 unread"]') as HTMLButtonElement;
  expect(bell).not.toBeNull();
  await act(async () => bell.click());
  expect(container.querySelector('[aria-label="Model notifications"]')).not.toBeNull();
});

it('shows a new completion as a snackbar without system permission and marks it read before navigating', async () => {
  vi.stubGlobal('Notification', {permission: 'denied'});
  vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({notifications: [ready('old')], active: [], unread_count: 1})
    .mockResolvedValue({notifications: [ready('new'), ready('old')], active: [], unread_count: 2});
  let finish!: (value: object) => void;
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  const snackbar = container.querySelector('[role="status"]')!;
  expect(snackbar.textContent).toContain('Your edit is ready');
  act(() => snackbar.querySelector('button')!.click());
  expect(mark).toHaveBeenCalledWith('new');
  expect(container.querySelector('output')?.textContent).toBe('/');
  await act(async () => finish({}));
  expect(container.querySelector('output')?.textContent).toBe('/generated-model?id=new&exact=1');
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(feed.unread_count).toBe(1);
  expect(feed.notifications.find(model => model.id === 'new')?.seen).toBe(true);
  await act(async () => container.querySelector('button')!.click());
  const link = container.querySelector('a[href="/generated-model?id=new&exact=1"]')!;
  expect(link.querySelector('[aria-label="Unread"]')).toBeNull();
  // Polling an older response must neither revive the badge nor repeat the snackbar.
  await act(async () => { feed.refresh(); });
  expect(feed.unread_count).toBe(1);
  expect(container.querySelector('[aria-label="Dismiss notification"]')).toBeNull();
});

it('queues simultaneous arrivals and keeps dismissed or expired notifications unread without repeating alerts', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({notifications: [], active: [], unread_count: 0})
    .mockResolvedValue({notifications: [ready('first'), {...ready('second'), is_edit: false}], active: [], unread_count: 2});
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockResolvedValue({});
  await render();
  // Refresh after an empty baseline must still recognize arrivals.
  await act(async () => { feed.refresh(); });
  expect(container.querySelectorAll('[aria-label="Dismiss notification"]')).toHaveLength(1);
  act(() => (container.querySelector('[aria-label="Dismiss notification"]') as HTMLButtonElement).click());
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Your model is ready');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(feed.unread_count).toBe(2);
  expect(mark).not.toHaveBeenCalled();
  await act(async () => { feed.refresh(); });
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('keeps an alert actionable when its read receipt fails and allows retry', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({notifications: [], active: [], unread_count: 0})
    .mockResolvedValue({notifications: [ready('new')], active: [], unread_count: 1});
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  await act(async () => container.querySelector('[role="status"] button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Please try again');
  expect(feed.unread_count).toBe(1);
  expect(container.querySelector('output')?.textContent).toBe('/');
  await act(async () => container.querySelector('[role="status"] button')!.click());
  expect(mark).toHaveBeenCalledTimes(2);
  expect(feed.unread_count).toBe(0);
  expect(container.querySelector('output')?.textContent).toBe('/generated-model?id=new&exact=1');
});

it('hides snackbar alerts on account change and prevents a pending click from navigating in another account', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({notifications: [], active: [], unread_count: 0})
    .mockResolvedValue({notifications: [ready('private')], active: [], unread_count: 1});
  let finish!: (value: object) => void;
  vi.spyOn(GenerationNotificationsApi, 'markViewed').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  act(() => container.querySelector('[role="status"] button')!.click());
  auth = {user: {id: 'another'}, session: {access_token: 'another-token'}, loading: false};
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({notifications: [], active: [], unread_count: 0});
  await render();
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => finish({}));
  expect(container.querySelector('output')?.textContent).toBe('/');
  expect(feed.unread_count).toBe(0);
});
