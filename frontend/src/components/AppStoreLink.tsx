import React from 'react';
import { Smartphone } from 'lucide-react';
import posthog from 'posthog-js';
import { isNativeMobileShell } from '../utils/mobileShellAnalytics';

export const APP_STORE_URL = 'https://apps.apple.com/app/brickbuilder-ai/id6815050463';

export function AppStoreLink({ placement, page }: { placement: 'header' | 'footer'; page: string }) {
  if (isNativeMobileShell()) return null;

  return <a href={APP_STORE_URL}
    aria-label="Download BrickBuilder AI for iOS on the App Store"
    className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2"
    onClick={() => posthog.capture('app_store_download_clicked', { page, placement, platform: 'ios', destination: APP_STORE_URL })}>
    <Smartphone aria-hidden="true" className="h-4 w-4" />
    Download for iOS
  </a>;
}
