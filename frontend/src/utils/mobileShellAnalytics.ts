import posthog from 'posthog-js';

export const MOBILE_SHELL_ANALYTICS_EVENT =
  'brickbuilder:mobile-shell-analytics';
export const CHANGE_REQUEST_ACCESS_MESSAGE =
  'brickbuilder:change-request-access';
export const OPEN_CHANGE_REQUEST_EVENT =
  'brickbuilder:open-change-request';

export type NativeMobileChangeRequestContext = Readonly<{
  requestId: string;
  branch: string;
  sha: string;
}>;

export type NativeMobileShellInfo = Readonly<{
  platform: 'ios' | 'android';
  version: string;
  applePurchases?: boolean;
  changeRequest?: NativeMobileChangeRequestContext;
}>;

declare global {
  interface Window {
    __BRICKBUILDER_NATIVE_APP__?: NativeMobileShellInfo;
    ReactNativeWebView?: {
      postMessage: (message: string) => void;
    };
  }
}

const ALLOWED_EVENT_NAMES = new Set([
  'mobile_shell_loaded',
  'mobile_shell_navigation_clicked',
  'mobile_shell_back_clicked',
  'mobile_shell_reload_clicked',
  'mobile_shell_external_link_opened',
  'mobile_shell_change_request_clicked',
]);

type AnalyticsProperty = string | number | boolean | null;

type MobileShellEventDetail = {
  eventName: string;
  properties?: Record<string, unknown>;
};

function isChangeRequestContext(value: unknown): value is NativeMobileChangeRequestContext {
  if (!value || typeof value !== 'object') return false;
  const context = value as Record<string, unknown>;
  return typeof context.requestId === 'string' &&
    typeof context.branch === 'string' &&
    typeof context.sha === 'string';
}

export function getNativeMobileShellInfo(): NativeMobileShellInfo | null {
  if (typeof window === 'undefined') return null;

  const shellInfo = window.__BRICKBUILDER_NATIVE_APP__;
  if (!shellInfo ||
    (shellInfo.platform !== 'ios' && shellInfo.platform !== 'android') ||
    typeof shellInfo.version !== 'string' ||
    (shellInfo.changeRequest !== undefined && !isChangeRequestContext(shellInfo.changeRequest))) {
    return null;
  }
  return shellInfo;
}

export function isNativeMobileShell(): boolean {
  return getNativeMobileShellInfo() !== null;
}

export function notifyMobileChangeRequestAccess(enabled: boolean): void {
  if (!isNativeMobileShell()) return;
  window.ReactNativeWebView?.postMessage(JSON.stringify({
    type: CHANGE_REQUEST_ACCESS_MESSAGE,
    enabled,
  }));
}

function isEventDetail(value: unknown): value is MobileShellEventDetail {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'eventName' in value &&
      typeof value.eventName === 'string' &&
      ALLOWED_EVENT_NAMES.has(value.eventName),
  );
}

function sanitizeProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, AnalyticsProperty> {
  if (!properties) return {};

  return Object.fromEntries(
    Object.entries(properties)
      .filter(([, value]) =>
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
      )
      .slice(0, 20),
  ) as Record<string, AnalyticsProperty>;
}

export function captureMobileShellAnalytics(detail: unknown): boolean {
  if (!isEventDetail(detail)) return false;

  posthog.capture(detail.eventName, sanitizeProperties(detail.properties));
  return true;
}

export function registerMobileShellAnalytics(): void {
  window.addEventListener(MOBILE_SHELL_ANALYTICS_EVENT, (event) => {
    captureMobileShellAnalytics((event as CustomEvent<unknown>).detail);
  });
}
