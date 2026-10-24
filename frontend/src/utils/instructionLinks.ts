const storagePrefix = 'brickbuilder:instruction-key:';
const validKey = /^[A-Za-z0-9_-]{43}$/;
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const memoryKeys = new Map<string, string>();

/** Run before analytics starts: fragments never reach HTTP logs or referrers. */
export function captureInstructionLink() {
  const url = new URL(window.location.href);
  const hash = new URLSearchParams(url.hash.slice(1));
  if (!hash.has('access')) return;
  const key = hash.get('access') || '';
  const id = url.searchParams.get('id') || '';
  hash.delete('access');
  url.hash = hash.toString();
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  if (!validKey.test(key) || !validId.test(id)) return;
  try { sessionStorage.setItem(storagePrefix + id, key); memoryKeys.delete(id); }
  catch { memoryKeys.set(id, key); }
}

export function getInstructionKey(generationId?: string | null): string | undefined {
  if (!generationId) return undefined;
  try {
    const key = sessionStorage.getItem(storagePrefix + generationId);
    if (key && validKey.test(key)) return key;
  } catch { /* Storage can be disabled. */ }
  return memoryKeys.get(generationId);
}

export function instructionKeys(): [string, string][] {
  const keys = new Map(memoryKeys);
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const name = sessionStorage.key(index)!;
      const id = name.slice(storagePrefix.length);
      const key = sessionStorage.getItem(name)!;
      if (name.startsWith(storagePrefix) && validId.test(id) && validKey.test(key)) keys.set(id, key);
    }
  } catch { /* Use in-memory links when storage is disabled. */ }
  return [...keys];
}

export function instructionsUrl(generationId: string): string {
  const key = getInstructionKey(generationId);
  return `https://brickbuilder.ai/instructions?id=${encodeURIComponent(generationId)}${key ? `#access=${key}` : ''}`;
}
