import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import posthog from 'posthog-js';
import { BuildBuddyDialogue } from '../src/components/BuildBuddyDialogue';
import { GenerationNotificationsProvider, useGenerationNotifications } from '../src/contexts/GenerationNotificationsContext';
import { GenerationNotificationsApi } from '../src/services/generationNotificationsApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, session: null, loading: false }) }));
const ready = (id: string, seen = false) => ({ id, prompt: `LEGO ${id}`, status: 'completed', seen,
  updated_at: '2026-10-17', image_url: `/previews/${id}.png`, is_edit: false });
let root: ReturnType<typeof createRoot>, container: HTMLDivElement;
let feed!: ReturnType<typeof useGenerationNotifications>;
const view = vi.fn();
function Conversation() {
  feed = useGenerationNotifications();
  return <BuildBuddyDialogue turns={[]} generations={[]} state="idle" onViewGeneration={view} />;
}
const render = () => act(async () => root.render(<MemoryRouter><GenerationNotificationsProvider><Conversation /></GenerationNotificationsProvider></MemoryRouter>));
const showBuilds = () => act(() => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Yes, show me')!.click());
beforeEach(() => {
  vi.useFakeTimers(); view.mockClear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.spyOn(GenerationNotificationsApi, 'list').mockResolvedValue({ notifications: [ready('ship'), ready('castle'), ready('viewed', true)], active: [], unread_count: 2 });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

it('asks about unread completions on reload, reveals their previews, and opens the selected inline model', async () => {
  const mark = vi.spyOn(GenerationNotificationsApi, 'markViewed').mockResolvedValue({});
  await render();
  expect(container.textContent).toContain('2 generations that are done building. Want to view them?');
  expect(container.querySelector('[aria-label="Completed builds"]')).toBeNull();
  showBuilds();
  expect(container.querySelectorAll('.pet-completed-builds li')).toHaveLength(2);
  expect(container.querySelector('img[alt="Preview of LEGO ship"]')?.getAttribute('src')).toBe('/previews/ship.png');
  expect(container.textContent).not.toContain('LEGO viewed');
  expect(posthog.capture).toHaveBeenCalledWith('build_buddy_completed_builds_shown', { unread_count: 2 });
  const link = container.querySelector<HTMLAnchorElement>('.pet-completed-builds a')!;
  expect(link.getAttribute('href')).toBe('/?id=ship&exact=1');
  act(() => link.click());
  expect(view).toHaveBeenCalledWith('ship');
  expect(mark).not.toHaveBeenCalled();
  expect(feed.unread_count).toBe(2);
  await act(async () => feed.markViewed('ship'));
  expect(container.textContent).toContain('a generation that’s done building. Want to view it?');
  expect(container.querySelector('img[alt="Preview of LEGO ship"]')).toBeNull();
  expect(container.querySelectorAll('.pet-completed-builds li')).toHaveLength(1);
  act(() => root.unmount()); root = createRoot(container);
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({ notifications: [ready('castle')], active: [], unread_count: 1 });
  await render();
  expect(container.textContent).toContain('a generation that’s done building');
  expect(container.querySelector('.pet-completed-builds')).toBeNull();
  showBuilds();
  await act(async () => feed.markViewed('castle'));
  expect(container.textContent).not.toContain('done building');
});

it('preserves native new-tab navigation and provides a card when a preview is unavailable', async () => {
  vi.mocked(GenerationNotificationsApi.list).mockResolvedValue({ notifications: [{ ...ready('model & edit'), image_url: undefined }], active: [], unread_count: 1 });
  await render(); showBuilds();
  const link = container.querySelector<HTMLAnchorElement>('.pet-completed-builds a')!;
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
  act(() => link.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(view).not.toHaveBeenCalled();
  expect(link.getAttribute('href')).toBe('/?id=model%20%26%20edit&exact=1');
  expect(link.textContent).toContain('View model');
});

it('keeps failed view receipts available and removes confirmed ones from stale polling responses', async () => {
  vi.spyOn(GenerationNotificationsApi, 'markViewed').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  await render(); showBuilds();
  await act(async () => { await expect(feed.markViewed('ship')).rejects.toThrow('Unable to mark'); });
  expect(feed.notifications.map(model => model.id)).toEqual(['ship', 'castle']);
  await act(async () => feed.markViewed('ship'));
  await act(async () => feed.refresh());
  expect(feed.notifications.map(model => model.id)).toEqual(['castle']);
});
