import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { GenerationNotificationsProvider, useGenerationNotifications } from '../src/contexts/GenerationNotificationsContext';
import { NotificationMenu } from '../src/components/NotificationMenu';
import { ProfileMenu } from '../src/components/ProfileMenu';
import posthog from 'posthog-js';
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

it('keeps opted-in background notifications working while polling idle feeds only once a minute', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  const native = vi.fn(function() { return { close: vi.fn() }; });
  Object.assign(native, { permission: 'granted' });
  vi.stubGlobal('Notification', native);
  const list = vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({ notifications: [], active: [], unread_count: 0 })
    .mockResolvedValueOnce({ notifications: [], active: [{ ...ready('build'), status: 'queued' }], unread_count: 0 })
    .mockResolvedValue({ notifications: [ready('build')], active: [], unread_count: 1 });
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
  expect(list).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(native).toHaveBeenCalledOnce();
});

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
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
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

it('opens dashboard notifications through its profile menu with an unread indicator', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({notifications: [ready('done')], active: [], unread_count: 1});
  vi.spyOn(GetUserGenerationsApiService, 'getUserGenerations').mockResolvedValue({
    generations: [], total_count: 0, total_user_generations: 0, all_orders: [], has_more: false,
  });
  await act(async () => root.render(<MemoryRouter initialEntries={['/dashboard']}>
    <GenerationNotificationsProvider><UserDashboard /></GenerationNotificationsProvider>
  </MemoryRouter>));
  expect(container.querySelector('header [data-testid="profile-notification-indicator"]')).not.toBeNull();
  expect(container.querySelector('header [aria-label="Notifications, 1 unread"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('header [aria-label="Account menu"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('header [aria-label="Notifications, 1 unread"]')!.click());
  expect(container.querySelector('[aria-label="Model notifications"]')).not.toBeNull();
});

it.each(['default', 'denied', 'granted', 'unsupported'])('keeps new completions in the notification menu without snackbars when browser permission is %s', async permission => {
  const native = vi.fn(function() { return { close: vi.fn() }; });
  Object.assign(native, { permission });
  vi.stubGlobal('Notification', permission === 'unsupported' ? undefined : native);
  vi.spyOn(GenerationNotificationsApi, 'list')
    .mockResolvedValueOnce({ notifications: [], active: [], unread_count: 0 })
    .mockResolvedValue({ notifications: [ready('edit'), { ...ready('model'), is_edit: false }], active: [], unread_count: 2 });
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockResolvedValue({});
  await render();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.querySelector('[aria-label="Dismiss notification"]')).toBeNull();
  expect(container.textContent).not.toContain('Your edit is ready');
  expect(container.textContent).not.toContain('Your model is ready');
  expect(container.querySelector('[data-testid="notification-badge"]')?.textContent).toBe('2');
  expect(mark).not.toHaveBeenCalled();
  expect(native).toHaveBeenCalledTimes(permission === 'granted' ? 2 : 0);
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('a[href="/generated-model?id=edit&exact=1"]')).not.toBeNull();
  expect(container.querySelector('a[href="/generated-model?id=model&exact=1"]')).not.toBeNull();
  expect(container.querySelectorAll('[aria-label="Unread"]')).toHaveLength(2);
  await act(async () => { feed.refresh(); });
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(feed.unread_count).toBe(2);
  expect(native).toHaveBeenCalledTimes(permission === 'granted' ? 2 : 0);
});

it('keeps failed read receipts unread and allows retry', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('new')], active: [], unread_count: 1 });
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  await render();
  await act(async () => { await expect(feed.markViewed('new')).rejects.toThrow('Unable to mark model as viewed'); });
  expect(feed.unread_count).toBe(1);
  await act(async () => { await feed.markViewed('new'); });
  expect(mark).toHaveBeenCalledTimes(2);
  expect(feed.unread_count).toBe(0);
});

it('ignores pending read receipts after switching accounts', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('private')], active: [], unread_count: 1 });
  let finish!: (value: object) => void;
  vi.spyOn(GenerationNotificationsApi, 'markViewed').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render();
  let pending!: Promise<void>;
  act(() => { pending = feed.markViewed('private'); });
  auth = { user: { id: 'another' }, session: { access_token: 'another-token' }, loading: false };
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({ notifications: [ready('other')], active: [], unread_count: 1 });
  await render();
  await act(async () => { finish({}); await pending; });
  expect(feed.unread_count).toBe(1);
  expect(feed.notifications.map(model => model.id)).toEqual(['other']);
  expect(feed.notifications[0].seen).toBe(false);
});

const renderProfile = (onNavigate?: (path: string) => void) => act(async () => {
  root.render(<MemoryRouter><GenerationNotificationsProvider><ProfileMenu onNavigate={onNavigate} /></GenerationNotificationsProvider></MemoryRouter>);
});
const accountButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Account menu"]')!;
const notificationsButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Notifications"]')!;
const openProfileNotifications = async () => {
  await act(async () => accountButton().click());
  await act(async () => notificationsButton().click());
};

it('replaces the separate bell with an unread profile indicator and returns from notifications with focus', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('done')], active: [], unread_count: 1 });
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockResolvedValue({});
  await renderProfile();
  expect(container.querySelectorAll('button')).toHaveLength(1);
  expect(accountButton().querySelector('[data-testid="profile-notification-indicator"]')).not.toBeNull();
  expect(document.getElementById(accountButton().getAttribute('aria-describedby')!)?.textContent).toBe('1 unread notifications');
  await openProfileNotifications();
  expect(container.textContent).not.toContain('My Generations');
  expect(container.querySelector('a')?.getAttribute('href')).toBe('/generated-model?id=done&exact=1');
  expect(posthog.capture).toHaveBeenCalledWith('generation_notifications_opened', { unread_count: 1, source: 'profile_menu' });
  const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to account menu"]')!;
  expect(document.activeElement).toBe(back);
  act(() => back.click());
  expect(container.querySelector('[aria-label="Model notifications"]')).toBeNull();
  expect(container.textContent).toContain('My Generations');
  expect(container.textContent).toContain('Settings');
  expect(document.activeElement).toBe(notificationsButton());
  expect(posthog.capture).toHaveBeenCalledWith('generation_notifications_back_clicked', { source: 'profile_menu' });
  expect(mark).not.toHaveBeenCalled();
});

it('closes the notifications submenu on Escape or outside click and reopens the profile view', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [], active: [], unread_count: 0 });
  await renderProfile();
  expect(container.querySelector('[data-testid="profile-notification-indicator"]')).toBeNull();
  await openProfileNotifications();
  expect(container.textContent).toContain('No notifications yet');
  act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(accountButton().getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(accountButton());
  act(() => accountButton().click());
  expect(container.textContent).toContain('My Generations');
  expect(container.querySelector('[aria-label="Back to account menu"]')).toBeNull();
  act(() => notificationsButton().click());
  act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
  expect(accountButton().getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[aria-label="Model notifications"]')).toBeNull();
});

it('clears the profile unread indicator through mark all read while retaining notification links', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('done')], active: [], unread_count: 1 });
  const markAll = vi.spyOn(GenerationNotificationsApi, 'markAllRead').mockResolvedValue({ seen_ids: ['done'] });
  await renderProfile();
  await openProfileNotifications();
  const action = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Mark all as read')!;
  await act(async () => action.click());
  expect(markAll).toHaveBeenCalledWith(['done']);
  expect(container.querySelector('[data-testid="profile-notification-indicator"]')).toBeNull();
  expect(accountButton().hasAttribute('aria-describedby')).toBe(false);
  expect(container.querySelector('a')).not.toBeNull();
  expect(action.disabled).toBe(true);
});

it('uses guarded navigation and closes the profile submenu when opening a notification', async () => {
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('model & edit')], active: [], unread_count: 1 });
  const onNavigate = vi.fn();
  await renderProfile(onNavigate);
  await openProfileNotifications();
  act(() => container.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
  expect(onNavigate).toHaveBeenCalledWith('/generated-model?id=model%20%26%20edit&exact=1');
  expect(accountButton().getAttribute('aria-expanded')).toBe('false');
  expect(container.querySelector('[aria-label="Model notifications"]')).toBeNull();
  act(() => accountButton().click());
  const settings = Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Settings')!;
  act(() => settings.click());
  expect(onNavigate).toHaveBeenLastCalledWith('/dashboard?tab=settings');
});
