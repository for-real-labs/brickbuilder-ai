const storageKey = 'brickbuilder.googleClick';
const validId = /^[a-zA-Z0-9_-]{1,500}$/;

export function googleClick(now = Date.now()): string | undefined {
  try {
    if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl || navigator.doNotTrack === '1') {
      localStorage.removeItem(storageKey);
      return;
    }
    const incoming = new URLSearchParams(location.search).get('gclid');
    if (incoming && validId.test(incoming)) {
      const navigation = performance.timeOrigin;
      localStorage.setItem(storageKey, JSON.stringify({ id: incoming, at: navigation }));
    }
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && typeof saved.id === 'string' && validId.test(saved.id)
      && saved.at <= now && now - saved.at < 90 * 86400000) return saved.id;
    localStorage.removeItem(storageKey);
  } catch { /* Storage can be unavailable in private browsing. */ }
}
