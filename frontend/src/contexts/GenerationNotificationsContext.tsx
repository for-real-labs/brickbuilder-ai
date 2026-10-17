import { getGeneratedModelPath } from '../utils/generationRoutes';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { startPolling } from '../utils/polling';
import { getGuestSession } from '../utils/guestSession';
import { GenerationNotificationsApi, NotificationFeed, NotificationApiError } from '../services/generationNotificationsApi';

const empty: NotificationFeed = { notifications: [], active: [], unread_count: 0 };
const Context = createContext({ ...empty, error: null as string | null, browserPermission: 'unsupported',
  enableBrowserNotifications: async () => {}, markViewed: async (_id: string) => {}, markAllRead: async () => {}, refresh: () => {} });
const readIds = (key: string): Set<string> => {
  try { const ids = JSON.parse(localStorage.getItem(key) || '[]'); return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []); }
  catch { return new Set(); }
};

export function GenerationNotificationsProvider({ children }: { children: React.ReactNode }) {
  const { user, session, loading } = useAuth();
  const owner = user?.id || `guest:${getGuestSession()}`;
  const navigate = useNavigate();
  const [state, setState] = useState({ owner, feed: empty, error: null as string | null });
  const [revision, setRevision] = useState(0);
  const baseline = useRef({ owner, initialized: false });
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const viewed = useRef(new Set<string>());
  const viewedOwner = useRef(owner);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (loading) return;
    const knownKey = `generation_notification_known:${owner}`;
    const deliveredKey = `generation_notification_delivered:${owner}`;
    const known = readIds(knownKey);
    const delivered = readIds(deliveredKey);
    // A fresh browser starts with a baseline rather than notifying for old history.
    if (baseline.current.owner !== owner) baseline.current = { owner, initialized: false };
    let initialized = baseline.current.initialized || known.size > 0 || delivered.size > 0;
    if (viewedOwner.current !== owner) { viewed.current.clear(); viewedOwner.current = owner; }
    const poll = async (signal: AbortSignal) => {
      try {
        const feed = await GenerationNotificationsApi.list(signal);
        if (signal.aborted) return;
        for (const id of readIds(deliveredKey)) delivered.add(id);
        for (const model of feed.notifications) {
          if (viewed.current.has(model.id)) model.seen = true;
          if (!initialized && !known.has(model.id)) delivered.add(model.id);
          if (initialized && !model.seen && !delivered.has(model.id)) {
            delivered.add(model.id);
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') try {
              const notification = new Notification(model.is_edit ? 'Your model edit is ready' : 'Your model is ready', {
                body: 'Open BrickBuilder to view your completed model.', tag: `brickbuilder:${model.id}`, icon: '/logo.svg',
              });
              notification.onclick = () => { posthog.capture('browser_generation_notification_clicked', { generation_id: model.id }); window.focus(); navigate(getGeneratedModelPath(model.id, true)); notification.close(); };
            } catch { /* The in-app badge still works if system notifications are unavailable. */ }
          }
          known.delete(model.id);
        }
        for (const model of feed.active) known.add(model.id);
        initialized = true;
        baseline.current.initialized = true;
        try {
          localStorage.setItem(knownKey, JSON.stringify([...known].slice(-1000)));
          localStorage.setItem(deliveredKey, JSON.stringify([...delivered].slice(-1000)));
        } catch { /* The server owns read receipts. */ }
        const next = { owner, feed: { ...feed, unread_count: feed.notifications.filter(model => !model.seen).length }, error: null };
        setState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
        return feed.active.length ? 5_000 : 60_000;
      } catch (error) {
        if (!signal.aborted) setState(previous => ({ ...previous, error: 'Unable to load notifications. Retrying…' }));
        throw error;
      }
    };
    const polling = startPolling(poll, {
      intervalMs: 5_000,
      // Keep opted-in completion notifications working for background builds.
      allowBackground: () => typeof Notification !== 'undefined' && Notification.permission === 'granted',
    });
    const onStorage = (event: StorageEvent) => {
      if (event.key === deliveredKey || event.key === knownKey) polling.refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => { polling.stop(); window.removeEventListener('storage', onStorage); };
  }, [owner, session?.access_token, loading, revision, navigate, refresh]);
  const markViewed = useCallback(async (id: string) => {
    if (viewed.current.has(id)) return;
    viewed.current.add(id);
    try {
      await GenerationNotificationsApi.markViewed(id);
      if (ownerRef.current !== owner) return;
      posthog.capture("generation_notification_read", { generation_id: id });
      setState(previous => previous.owner !== owner ? previous : ({ ...previous, feed: { ...previous.feed,
        notifications: previous.feed.notifications.map(model => model.id === id ? { ...model, seen: true } : model),
        unread_count: Math.max(0, previous.feed.unread_count - (previous.feed.notifications.some(model => model.id === id && !model.seen) ? 1 : 0)),
      } }));
    } catch (error) {
      // Public community models have no receipt in this owner's feed.
      if (error instanceof NotificationApiError && error.status === 404) return;
      if (ownerRef.current === owner) viewed.current.delete(id);
      throw new Error('Unable to mark model as viewed');
    }
  }, [owner]);
  const enableBrowserNotifications = async () => {
    if (typeof Notification !== 'undefined') {
      try { setPermission(await Notification.requestPermission()); refresh(); } catch { setPermission('unsupported'); }
    }
  };
  const markAllRead = useCallback(async () => {
    if (state.owner !== owner) return;
    const ids = state.feed.notifications.filter(model => !model.seen).map(model => model.id);
    if (!ids.length) return;
    const { seen_ids } = await GenerationNotificationsApi.markAllRead(ids);
    if (ownerRef.current !== owner) return;
    const seen = new Set(seen_ids);
    seen_ids.forEach(id => viewed.current.add(id));
    setState(previous => {
      if (previous.owner !== owner) return previous;
      const notifications = previous.feed.notifications.map(model => seen.has(model.id) ? { ...model, seen: true } : model);
      return { ...previous, feed: { ...previous.feed, notifications, unread_count: notifications.filter(model => !model.seen).length } };
    });
  }, [owner, state]);
  return <Context.Provider value={{ ...(state.owner === owner ? state.feed : empty), error: state.owner === owner ? state.error : null,
    browserPermission: permission, enableBrowserNotifications, markViewed, markAllRead, refresh }}>
    {children}
  </Context.Provider>;
}
export const useGenerationNotifications = () => useContext(Context);
