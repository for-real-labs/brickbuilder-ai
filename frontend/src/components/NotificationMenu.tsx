import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import posthog from 'posthog-js';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';

export function NotificationMenu({ onNavigate }: { onNavigate?: (path: string) => void }) {
  const feed = useGenerationNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div ref={ref} className="relative shrink-0">
    <button ref={button} type="button" aria-label={`Notifications${feed.unread_count ? `, ${feed.unread_count} unread` : ''}`}
      aria-expanded={open} aria-controls="model-notifications" onClick={() => {
        setOpen(value => !value); if (!open) { feed.refresh(); posthog.capture('generation_notifications_opened', { unread_count: feed.unread_count }); }
      }} className="relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-400">
      <Bell size={18} />
      {feed.unread_count > 0 && <span data-testid="notification-badge" className="absolute -right-1 -top-1 flex min-h-4 min-w-4 items-center justify-center rounded-full bg-[#f44336] px-1 text-[10px] font-bold text-white ring-2 ring-white">{feed.unread_count > 99 ? '99+' : feed.unread_count}</span>}
    </button>
    {open && <section id="model-notifications" aria-label="Model notifications" className="fixed left-4 right-4 top-24 z-[70] w-auto sm:absolute sm:left-auto sm:top-auto sm:mt-3 sm:w-[22rem] overflow-hidden rounded-2xl border border-slate-200 bg-white text-left shadow-xl">
      <div className="border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-semibold text-slate-900">Notifications</h2><p className="mt-1 text-xs text-slate-500">Completed models are unread until you view them.</p></div>
      <div className="max-h-80 overflow-y-auto">
        {feed.error && <p role="status" className="px-4 py-3 text-xs text-red-600">{feed.error}</p>}
        {!feed.error && !feed.active.length && !feed.notifications.length && <p className="px-4 py-8 text-center text-sm text-slate-500">No notifications yet</p>}
        {[...feed.active, ...feed.notifications].map(model => <a key={model.id} href={`/generated-model?id=${encodeURIComponent(model.id)}&exact=1`}
          onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); setOpen(false);
            posthog.capture('generation_notification_clicked', { generation_id: model.id, status: model.status });
            (onNavigate || navigate)(`/generated-model?id=${encodeURIComponent(model.id)}&exact=1`);
          }} className={`flex gap-3 border-b border-slate-100 px-4 py-3 hover:bg-slate-100 ${!model.seen && model.status === 'completed' ? 'bg-red-50/60' : ''}`}>
          <span className="mt-1 shrink-0 text-slate-400">{model.status === 'completed' ? <BellRing size={17} /> : <Loader2 size={17} className="animate-spin" />}</span>
          <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-800">{model.status === 'completed' ? (model.is_edit ? 'Your edit is ready' : 'Your model is ready') : 'Model in progress'}</span><span className="mt-1 block truncate text-xs text-slate-500">{model.prompt}</span></span>
          {!model.seen && model.status === 'completed' && <span aria-label="Unread" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#f44336]" />}
        </a>)}
      </div>
      {feed.browserPermission === 'default' && <button type="button" onClick={() => { posthog.capture('browser_notifications_enable_clicked'); void feed.enableBrowserNotifications(); }} className="w-full px-4 py-3 text-left text-xs font-medium text-[#f44336] hover:bg-slate-50">Enable browser notifications</button>}
      {feed.browserPermission === 'denied' && <p className="px-4 py-3 text-xs text-slate-500">Browser notifications are blocked. You can enable them in your browser settings.</p>}
    </section>}
  </div>;
}
