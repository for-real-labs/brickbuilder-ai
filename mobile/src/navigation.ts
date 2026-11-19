export const APP_ROUTES = {
  create: '/',
  dashboard: '/dashboard',
} as const;

export type NavigationDisposition = 'webview' | 'external' | 'blocked';

const WEBVIEW_PROTOCOLS = new Set(['about:', 'blob:', 'data:']);
const EXTERNAL_PROTOCOLS = new Set(['https:', 'mailto:', 'tel:']);

const isHostOrSubdomain = (hostname: string, expected: string): boolean =>
  hostname === expected || hostname.endsWith(`.${expected}`);

const isTrustedWebFlowHost = (hostname: string): boolean =>
  isHostOrSubdomain(hostname, 'supabase.co') ||
  hostname === 'accounts.google.com' ||
  isHostOrSubdomain(hostname, 'googleusercontent.com') ||
  isHostOrSubdomain(hostname, 'stripe.com');

export function buildAppUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  const destination = new URL(path, `${base.origin}/`);

  if (destination.origin !== base.origin) {
    throw new Error('App navigation must stay on the configured web-app origin.');
  }

  return destination.toString();
}

export function classifyNavigation(
  rawUrl: string,
  baseUrl: string,
  isTopFrame = true,
): NavigationDisposition {
  let destination: URL;

  try {
    destination = new URL(rawUrl);
  } catch {
    return 'blocked';
  }

  // Stripe.js loads this separately from its stripe.com payment frames.
  // It belongs inside checkout and has no standalone browser page.
  if (destination.hostname === 'm.stripe.network') {
    return isTopFrame === false && destination.origin === 'https://m.stripe.network'
      ? 'webview'
      : 'blocked';
  }

  if (WEBVIEW_PROTOCOLS.has(destination.protocol)) {
    return 'webview';
  }

  if (destination.protocol === 'http:' || destination.protocol === 'https:') {
    const appOrigin = new URL(baseUrl).origin;
    if (
      destination.origin === appOrigin ||
      isTrustedWebFlowHost(destination.hostname)
    ) {
      return 'webview';
    }
  }

  return EXTERNAL_PROTOCOLS.has(destination.protocol) ? 'external' : 'blocked';
}

export function getExternalLinkHostname(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname || null;
  } catch {
    return null;
  }
}
