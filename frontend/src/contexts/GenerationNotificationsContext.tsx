import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getGuestSession } from '../utils/guestSession';
import { GenerationNotificationsApi, NotificationFeed, NotificationApiError, ModelNotification } from '../services/generationNotificationsApi';
import { GenerationNotificationSnackbar } from '../components/GenerationNotificationSnackbar';
import { getGeneratedModelPath } from '../utils/generationRoutes';

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
  const [alerts, setAlerts] = useState<{ owner: string; notifications: ModelNotification[] }>({ owner, notifications: [] });
  const baseline = useRef({ owner, initialized: false });
  const [permission, setPermission] = useState(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const viewed = useRef(new Set<string>());
  const viewedOwner = useRef(owner);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (loading) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const knownKey = `generation_notification_known:${owner}`;
    const deliveredKey = `generation_notification_delivered:${owner}`;
    const known = readIds(knownKey);
    const delivered = readIds(deliveredKey);
    // A fresh browser starts with a baseline rather than notifying for old history.
    if (baseline.current.owner !== owner) baseline.current = { owner, initialized: false };
    let initialized = baseline.current.initialized || known.size > 0 || delivered.size > 0;
    if (viewedOwner.current !== owner) { viewed.current.clear(); viewedOwner.current = owner; }
    const poll = async () => {
      try {
        const feed = await GenerationNotificationsApi.list(controller.signal);
        if (controller.signal.aborted) return;
        for (const id of readIds(deliveredKey)) delivered.add(id);
        const arrivals: ModelNotification[] = [];
        for (const model of feed.notifications) {
          if (viewed.current.has(model.id)) model.seen = true;
          if (!initialized && !known.has(model.id)) delivered.add(model.id);
          if (initialized && !model.seen && !delivered.has(model.id)) {
            arrivals.push(model);
            delivered.add(model.id);
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') try {
              const notification = new Notification(model.is_edit ? 'Your model edit is ready' : 'Your model is ready', {
                body: 'Open BrickBuilder to view your completed model.', tag: `brickbuilder:${model.id}`, icon: '/logo.svg',
              });
              notification.onclick = () => { posthog.capture('browser_generation_notification_clicked', { generation_id: model.id }); window.focus(); navigate(`/generated-model?id=${encodeURIComponent(model.id)}&exact=1`); notification.close(); };
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
        setAlerts(previous => ({ owner, notifications: [
          ...(previous.owner === owner ? previous.notifications.filter(model =>
            !viewed.current.has(model.id) && !feed.notifications.some(current => current.id === model.id && current.seen)) : []),
          ...arrivals,
        ] }));
        setState({ owner, feed: { ...feed, unread_count: feed.notifications.filter(model => !model.seen).length }, error: null });
      } catch {
        if (!controller.signal.aborted) setState(previous => ({ ...previous, error: 'Unable to load notifications. Retrying…' }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 5000);
      }
    };
    const onFocus = () => { refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onFocus);
    void poll();
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener('focus', onFocus); window.removeEventListener('storage', onFocus); };
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
      setAlerts(previous => previous.owner !== owner ? previous : ({ ...previous,
        notifications: previous.notifications.filter(model => model.id !== id),
      }));
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
  const dismissAlert = useCallback((id: string) => {
    setAlerts(previous => previous.owner !== owner ? previous : ({ ...previous,
      notifications: previous.notifications.filter(model => model.id !== id),
    }));
  }, [owner]);
  const openAlert = useCallback(async (id: string) => {
    await markViewed(id);
    if (ownerRef.current !== owner) return;
    dismissAlert(id);
    navigate(getGeneratedModelPath(id, true));
  }, [owner, markViewed, dismissAlert, navigate]);
  const alert = alerts.owner === owner ? alerts.notifications.find(model =>
    !state.feed.notifications.some(current => current.id === model.id && current.seen)) : undefined;
  return <Context.Provider value={{ ...(state.owner === owner ? state.feed : empty), error: state.owner === owner ? state.error : null,
    browserPermission: permission, enableBrowserNotifications, markViewed, markAllRead, refresh }}>
    {children}
    {alert && <GenerationNotificationSnackbar key={alert.id} notification={alert} onOpen={openAlert} onDismiss={dismissAlert} />}
  </Context.Provider>;
}
export const useGenerationNotifications = () => useContext(Context);
