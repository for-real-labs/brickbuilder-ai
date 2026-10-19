import { apiFetch } from './apiFetch';
import { BUDDY_TOOL_INTENTS, isBuddyToolIntent, type BuddyToolIntent } from '../utils/buddyTools';

export interface BuddyHistoryMessage { role: 'user' | 'assistant'; text: string }
export interface BuddyReplyRequest {
  pet: string;
  prompt: string;
  imageBase64?: string;
  imageMediaType?: string;
  history: BuddyHistoryMessage[];
  intent?: 'question' | 'chat' | 'clarify';
}

export interface GiftReply { reply: string; buildPrompt?: string }
export type BuddyIntent = BuddyToolIntent | 'generate' | 'upload' | 'question' | 'chat' | 'gift' | 'clarify';
export interface BuddyIntentDecision { intent: BuddyIntent; confidence: number }

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
        image_base64: request.imageBase64, image_media_type: request.imageMediaType || 'image/png', history: request.history,
        ...(request.intent ? { mode: request.intent } : {}) }),
  });
  if (!response.ok) throw new Error('Your build buddy’s chat is unavailable.');
  const data = await response.json();
  if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Empty buddy reply');
  return data;
}

export const BuildBuddyApi = {
  async welcomeGreeting(pet: string, authToken: string | undefined, signal: AbortSignal, previousGreetings: string[] = []): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${base}/build-buddy/welcome-greeting`, {
      method: 'POST', headers, signal, body: JSON.stringify({ pet, previous_greetings: previousGreetings.slice(-8) }),
    });
    if (!response.ok) throw new Error('Welcome greeting unavailable.');
    const data = await response.json();
    if (typeof data.greeting !== 'string' || !data.greeting.trim() || data.greeting.length > 120) {
      throw new Error('Invalid welcome greeting response.');
    }
    return data.greeting.trim();
  },
  async randomIdea(previousIdeas: string[], authToken: string | undefined, signal: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${base}/build-buddy/random-idea`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ previous_ideas: previousIdeas.slice(-8) }),
    });
    if (!response.ok) throw new Error('Build ideas are unavailable right now.');
    const data = await response.json();
    if (typeof data.idea !== 'string' || !data.idea.trim() || data.idea.length > 120) {
      throw new Error('Invalid build idea response.');
    }
    return data.idea.trim();
  },
  async modelGreeting(request: { generationId: string; pet: string; previousFacts?: string[] }, authToken: string | undefined, signal: AbortSignal): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${base}/build-buddy/model-greeting`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ generation_id: request.generationId, pet: request.pet,
        previous_facts: request.previousFacts?.slice(-8) || [] }),
    });
    if (!response.ok) throw new Error('Model greeting unavailable.');
    const data = await response.json();
    if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Empty model greeting');
    return data.reply.trim().slice(0, 240);
  },
  async classify(request: { prompt: string; history: BuddyHistoryMessage[]; hasImage: boolean; modelName?: string; giftPlanning?: boolean },
    authToken: string | undefined, signal: AbortSignal): Promise<BuddyIntentDecision> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await apiFetch(`${base}/build-buddy/intent`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ prompt: request.prompt, history: request.history, has_image: request.hasImage,
        model_name: request.modelName?.slice(0, 200), gift_planning: request.giftPlanning ?? false }),
    });
    if (!response.ok) throw new Error('Message routing is unavailable.');
    const data = await response.json();
    const intents: BuddyIntent[] = ['generate', 'upload', 'question', 'chat', 'gift', 'clarify', ...BUDDY_TOOL_INTENTS];
    if (!intents.includes(data.intent) || typeof data.confidence !== 'number' || !Number.isFinite(data.confidence)
      || data.confidence < 0 || data.confidence > 1) throw new Error('Invalid message routing response.');
    return { intent: data.confidence < (isBuddyToolIntent(data.intent) ? 0.75 : 0.5) ? 'clarify' : data.intent, confidence: data.confidence };
  },
  async reply(request: BuddyReplyRequest, authToken: string | undefined, signal: AbortSignal): Promise<string> {
    return (await sendReply(request, authToken, signal)).reply;
  },
  async planGift(request: BuddyReplyRequest, authToken: string | undefined, signal: AbortSignal): Promise<GiftReply> {
    const data = await sendReply(request, authToken, signal, true);
    return { reply: data.reply, buildPrompt: typeof data.build_prompt === 'string' && data.build_prompt.trim()
      ? data.build_prompt.trim().slice(0, 2000) : undefined };
  },
};
