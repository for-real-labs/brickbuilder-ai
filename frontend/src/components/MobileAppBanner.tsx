import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import posthog from 'posthog-js';
import { APP_STORE_URL } from './AppStoreLink';
import { isNativeMobileShell } from '../utils/mobileShellAnalytics';

const DISMISSAL_KEY = 'brickbuilder_app_banner_dismissed_until';
const DISMISSAL_MS = 7 * 24 * 60 * 60 * 1000;
const QUIET_ROUTES = new Set(['/login', '/signup', '/oauth/consent', '/order', '/success']);

function needsFallbackBanner(): boolean {
  const { userAgent, platform, maxTouchPoints } = navigator;
  const isIos = /iPhone|iPad|iPod/i.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  // Safari owns its native Smart App Banner, including installed-app detection and dismissal.
  const isSafari = /Version\/\d.*Safari\//.test(userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram/i.test(userAgent);
  const isStandalone = (navigator as Navigator & { standalone?: boolean }).standalone
    || window.matchMedia?.('(display-mode: standalone)').matches;
  return isIos && !isSafari && !isStandalone && !isNativeMobileShell();
}

export function MobileAppBanner() {
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  const showBanner = visible && !QUIET_ROUTES.has(pathname);

  useEffect(() => {
    if (!needsFallbackBanner()) return;
    try {
      const dismissedUntil = Number(localStorage.getItem(DISMISSAL_KEY));
      if (Number.isFinite(dismissedUntil) && dismissedUntil > Date.now()) return;
    } catch { /* The prompt still works when browser storage is unavailable. */ }
    setVisible(true);
  }, []);

  useEffect(() => {
    if (showBanner) posthog.capture('app_store_banner_shown', { page: pathname, platform: 'ios' });
  }, [showBanner, pathname]);

  if (!showBanner) return null;

  return <aside aria-label="Get the BrickBuilder AI app" className="w-full border-b border-slate-200 bg-slate-50">
    <div className="mx-auto flex max-w-7xl items-center gap-2 px-2 py-3 sm:px-4">
      <button type="button" aria-label="Dismiss app download prompt"
        className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-slate-500 hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336]"
        onClick={() => {
          setVisible(false);
          try { localStorage.setItem(DISMISSAL_KEY, String(Date.now() + DISMISSAL_MS)); } catch { /* Keep this visit dismissed. */ }
          posthog.capture('app_store_banner_dismissed', { page: pathname, platform: 'ios' });
        }}>
        <X aria-hidden="true" className="h-4 w-4" />
      </button>
      <img src="/brickbuilder-logo.PNG" alt="" width="48" height="48" className="h-12 w-12 shrink-0 rounded-xl" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-slate-900">BrickBuilder AI</p>
        <p className="text-xs leading-4 text-slate-600">Build on the go.<br />Free on the App Store.</p>
      </div>
      <a href={APP_STORE_URL} aria-label="Get BrickBuilder AI on the App Store"
        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-[#f44336] px-4 text-sm font-semibold text-white hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2"
        onClick={() => posthog.capture('app_store_download_clicked', {
          page: pathname, placement: 'mobile_banner', platform: 'ios', destination: APP_STORE_URL,
        })}>Get app</a>
    </div>
  </aside>;
}
