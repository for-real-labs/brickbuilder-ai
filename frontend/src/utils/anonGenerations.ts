// Tracks the ids of generations that THIS browser created while the visitor was
// logged out. On login these ids are claimed (by id) for the now-authenticated
// user via the /claimGeneration endpoint. This replaces the old, unsafe
// IP-hash-based bulk migration, which could sweep other users' anonymous
// generations into whoever loaded the dashboard first when behind a proxy.

// Legacy IDs cannot prove ownership and must not be claimed automatically.
const STORAGE_KEY = 'anon_generation_ids_v2';

export function getAnonymousGenerationIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function recordAnonymousGeneration(id: string | null | undefined): void {
  if (!id) return;
  try {
    const ids = getAnonymousGenerationIds();
    if (!ids.includes(id)) {
      ids.push(id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    // localStorage may be unavailable in some environments; ignore.
  }
}

export function removeAnonymousGenerationId(id: string): void {
  try {
    const ids = getAnonymousGenerationIds().filter((x) => x !== id);
    if (ids.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    // ignore
  }
}

export function clearAnonymousGenerationIds(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
