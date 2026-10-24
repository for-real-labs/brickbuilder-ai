import type { MobileChangeRequestContext } from './config';

export const MOBILE_ANALYTICS_EVENT = 'brickbuilder:mobile-shell-analytics';

export type MobileShellEventName =
  | 'mobile_shell_loaded'
  | 'mobile_shell_navigation_clicked'
  | 'mobile_shell_back_clicked'
  | 'mobile_shell_reload_clicked'
  | 'mobile_shell_change_request_clicked'
  | 'mobile_shell_external_link_opened';

type AnalyticsProperty = string | number | boolean | null;

export function createAnalyticsDispatchScript(
  eventName: MobileShellEventName,
  properties: Record<string, AnalyticsProperty> = {},
): string {
  const detail = JSON.stringify({ eventName, properties });
  const browserEventName = JSON.stringify(MOBILE_ANALYTICS_EVENT);

  return `window.dispatchEvent(new CustomEvent(${browserEventName}, { detail: ${detail} })); true;`;
}

export function createNativeBootstrapScript(
  platform: 'ios' | 'android',
  changeRequest: MobileChangeRequestContext = {
    requestId: '',
    branch: 'main',
    sha: '',
  },
): string {
  const shellInfo = JSON.stringify({
    platform,
    version: '0.2.0',
    applePurchases: platform === 'ios',
    changeRequest,
  });

  return `
    window.__BRICKBUILDER_NATIVE_APP__ = Object.freeze(${shellInfo});
    (function () {
      function installNativeStyles() {
        if (document.getElementById('brickbuilder-native-shell-style')) return;
        var style = document.createElement('style');
        style.id = 'brickbuilder-native-shell-style';
        style.textContent = '[data-native-mobile-hidden="true"] { display: none !important; }';
        (document.head || document.documentElement).appendChild(style);
      }
      installNativeStyles();
      document.addEventListener('DOMContentLoaded', installNativeStyles, { once: true });
    })();
    true;
  `;
}
