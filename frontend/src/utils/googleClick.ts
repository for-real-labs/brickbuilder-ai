const storageKey = 'brickbuilder.googleClick';
const validId = /^[a-zA-Z0-9_-]{1,500}$/;

function optedOut() {
  return (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl || navigator.doNotTrack === '1';
}

export function landingClick(): string | null {
  const id = new URLSearchParams(location.search).get('gclid');
  return !optedOut() && id && validId.test(id) ? id : null;
}

export function saveClick(id: string | null) {
  try {
    localStorage.removeItem(storageKey);
    if (id && validId.test(id) && !optedOut()) {
      localStorage.setItem(storageKey, JSON.stringify({ id, at: Date.now() }));
    }
  } catch { /* Checkout also works without browser storage. */ }
}

export function googleClick(now = Date.now()): string | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!optedOut() && saved && typeof saved.id === 'string' && validId.test(saved.id)
      && saved.at <= now && now - saved.at < 90 * 86400000) return saved.id;
    localStorage.removeItem(storageKey);
  } catch { /* Storage can be unavailable in private browsing. */ }
}
