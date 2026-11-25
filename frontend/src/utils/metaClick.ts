const storageKey = 'brickbuilder.metaAdClick';
const clickWindow = 7 * 86400000;
const validId = /^[A-Za-z0-9_-]{1,430}$/;
export const META_MEASUREMENT_CHANGED = 'meta-ad-measurement-changed';

type MetaClick = { id: string; clicked_at: number };

function enabled() {
  return import.meta.env.VITE_META_AD_MEASUREMENT === 'true'
    && !(navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl
    && navigator.doNotTrack !== '1';
}

export function metaLandingClick(search: string, now = Date.now()): MetaClick | undefined {
  const id = new URLSearchParams(search).get('fbclid');
  if (enabled() && id && validId.test(id)) return { id, clicked_at: now };
}

export function saveMetaClick(click?: MetaClick) {
  try {
    sessionStorage.removeItem(storageKey);
    if (click && enabled()) sessionStorage.setItem(storageKey, JSON.stringify(click));
  } catch { /* Checkout remains available when browser storage is disabled. */ }
}

export function metaClick(now = Date.now()): MetaClick | undefined {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (enabled() && saved && typeof saved.id === 'string' && validId.test(saved.id)
        && Number.isSafeInteger(saved.clicked_at) && saved.clicked_at > 0
        && saved.clicked_at <= now && now - saved.clicked_at < clickWindow) return saved;
    sessionStorage.removeItem(storageKey);
  } catch { /* Checkout remains available when browser storage is disabled. */ }
}
