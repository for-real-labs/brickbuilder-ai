import { getNativeMobileShellInfo } from '../utils/mobileShellAnalytics';
export const APPLE_EVENT = 'brickbuilder:apple-purchases';
export const isAppleApp = () => getNativeMobileShellInfo()?.platform === 'ios';
export const hasApplePurchases = () => isAppleApp() && getNativeMobileShellInfo()?.applePurchases === true;
export const appleProduct = (key: string) => `ai.brickbuilder.app.${key}.monthly`;
export type AppleProduct = { id: string; displayPrice: string };

export function appleRequest<T>(action: string, values: Record<string, string> = {}): Promise<T> {
  if (!hasApplePurchases()) return Promise.reject(new Error('Update BrickBuilder from the App Store to purchase or restore Apple subscriptions.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const done = () => { window.clearTimeout(timer); window.removeEventListener(APPLE_EVENT, listener); };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail?.id !== id) return;
      done();
      if (detail.error) reject(new Error(detail.error)); else resolve(detail.result as T);
    };
    const timer = window.setTimeout(() => { done(); reject(new Error('Apple is taking longer than expected. If you completed payment, use Restore purchases.')); }, 120000);
    window.addEventListener(APPLE_EVENT, listener);
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: APPLE_EVENT, id, action, ...values }));
  });
}
