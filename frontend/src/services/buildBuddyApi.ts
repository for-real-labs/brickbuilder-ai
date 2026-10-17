import { apiFetch } from './apiFetch';

export interface BuddyHistoryMessage { role: 'user' | 'assistant'; text: string }
export interface BuddyReplyRequest {
  pet: string;
  prompt: string;
  imageBase64?: string;
  imageMediaType?: string;
  history: BuddyHistoryMessage[];
}

export interface GiftReply { reply: string; buildPrompt?: string }

const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? (import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002')
  : mode === 'railway_staging' ? (import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app')
    : (import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app');

interface BuddyResponse { reply: string; build_prompt?: unknown }

async function sendReply(request: BuddyReplyRequest, authToken: string | undefined, signal: AbortSignal, gift = false): Promise<BuddyResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await apiFetch(`${base}/build-buddy/reply`, {
    method: 'POST', headers, signal,
    body: JSON.stringify(gift ? { pet: request.pet, prompt: request.prompt, history: request.history, mode: 'gift' }
      : { pet: request.pet, prompt: request.prompt,
        image_base64: request.imageBase64, image_media_type: request.imageMediaType || 'image/png', history: request.history }),
  });
  if (!response.ok) throw new Error('Your build buddy’s chat is unavailable.');
  const data = await response.json();
  if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Empty buddy reply');
  return data;
}

export const BuildBuddyApi = {
  async reply(request: BuddyReplyRequest, authToken: string | undefined, signal: AbortSignal): Promise<string> {
    return (await sendReply(request, authToken, signal)).reply;
  },
  async planGift(request: BuddyReplyRequest, authToken: string | undefined, signal: AbortSignal): Promise<GiftReply> {
    const data = await sendReply(request, authToken, signal, true);
    return { reply: data.reply, buildPrompt: typeof data.build_prompt === 'string' && data.build_prompt.trim()
      ? data.build_prompt.trim().slice(0, 2000) : undefined };
  },
};
