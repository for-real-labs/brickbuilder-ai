import { prepareImageUpload } from '../utils/prepareImageUpload';

export interface RecognizedPart {
  id: string;
  name: string;
  imageUrl: string | null;
  score: number;
}

function thumbnail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'storage.googleapis.com'
      && url.pathname.startsWith('/brickognize-static/') ? url.href : null;
  } catch { return null; }
}

export async function recognizeParts(file: File, signal: AbortSignal): Promise<RecognizedPart[]> {
  const image = await prepareImageUpload(file);
  signal.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 45_000);
  try {
    const body = new FormData();
    body.append('query_image', image);
    // Do not send our authentication headers to this third-party service.
    const response = await fetch('https://api.brickognize.com/predict/parts/', {
      method: 'POST', body, signal: controller.signal, credentials: 'omit',
    });
    if (!response.ok) {
      throw new Error(response.status === 429
        ? 'Brickognize is busy. Please wait a moment and try again.'
        : 'Brickognize could not recognize this image. Please try a clear photo of one part.');
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.items)) throw new Error('Brickognize returned an unreadable result. Please try again.');
    const parts = new Map<string, RecognizedPart>();
    for (const item of data.items.slice(0, 50)) {
      if (!item || item.type !== 'part' || typeof item.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(item.id)
        || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 500
        || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 1) continue;
      const part = { id: item.id, name: item.name, imageUrl: thumbnail(item.img_url), score: item.score };
      if (!parts.has(part.id) || parts.get(part.id)!.score < part.score) parts.set(part.id, part);
    }
    return [...parts.values()].sort((a, b) => b.score - a.score);
  } catch (error) {
    if (signal.aborted) throw error;
    if (controller.signal.aborted) throw new Error('Recognition took too long. Please try again.');
    if (error instanceof TypeError) throw new Error('Could not reach Brickognize. Check your connection and try again.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}
