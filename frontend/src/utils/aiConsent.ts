export const AI_CONSENT_VERSION = '2026-10-02';
export const AI_CONSENT_KEY = 'brickbuilder.ai-consent';
export const AI_PROVIDERS = 'OpenAI, Anthropic, fal.ai, and RunPod';
export const AI_SHARED_DATA = 'Your text prompts and edit instructions, reference images or photos you select, and model data and previews needed to create or edit your brick model.';

const AI_ENDPOINTS = new Set([
  'llmToBricks', 'llmRender', 'textToBricks', 'imageToBricks', 'promptEditModel',
  // Conversions and saved edits can also generate an AI model title.
  'glbToBricks', 'resizeModel', 'updateModel',
]);

type ConsentPrompt = () => Promise<boolean>;
let prompt: ConsentPrompt | undefined;
let pending: Promise<void> | undefined;

export function hasAiConsent(): boolean {
  try { return localStorage.getItem(AI_CONSENT_KEY) === AI_CONSENT_VERSION; }
  catch { return false; }
}

export function saveAiConsent(allowed: boolean): void {
  try {
    if (allowed) localStorage.setItem(AI_CONSENT_KEY, AI_CONSENT_VERSION);
    else localStorage.removeItem(AI_CONSENT_KEY);
  } catch { /* Consent still applies to the current request if storage is unavailable. */ }
}

export function registerAiConsentPrompt(handler: ConsentPrompt): () => void {
  prompt = handler;
  return () => { if (prompt === handler) prompt = undefined; };
}

export async function openAiConsentSettings(): Promise<boolean> {
  if (!prompt) throw new Error('AI privacy controls are unavailable. Please reload the app.');
  return prompt();
}

export function requiresAiConsent(url: string, method = 'GET'): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const path = new URL(url, window.location.origin).pathname.split('/').filter(Boolean);
  return path.some(segment => AI_ENDPOINTS.has(segment));
}

export async function ensureAiConsent(): Promise<void> {
  if (hasAiConsent()) return;
  if (!pending) {
    pending = openAiConsentSettings().then(allowed => {
      if (!allowed) throw new Error('AI sharing was not allowed. Your content was not sent for this request.');
    }).finally(() => { pending = undefined; });
  }
  return pending;
}
