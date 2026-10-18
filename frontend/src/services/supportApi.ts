import { authenticatedApiFetch } from './apiFetch';

export const SUPPORT_EMAIL = 'support@brickbuilder.ai';
export const MAX_SUPPORT_MESSAGE = 5000;
const mode = import.meta.env.VITE_API_MODE || 'local';
const base = mode === 'local' ? (import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002')
  : mode === 'railway_staging' ? (import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app')
    : (import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app');
const failureMessage = `Could not send. Try again or email ${SUPPORT_EMAIL}.`;

export interface SupportMessage { email: string; message: string; generationId?: string; requestId: string }

export async function sendSupport(message: SupportMessage): Promise<void> {
  const email = message.email.trim();
  const text = message.message.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email.');
  if (!text) throw new Error('Enter a message.');
  if (text.length > MAX_SUPPORT_MESSAGE) throw new Error('Keep your message under 5,000 characters.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await authenticatedApiFetch(`${base}/support-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ email, message: text, generation_id: message.generationId, request_id: message.requestId }),
    });
    if (response.status === 429) throw new Error('Too many messages. Wait a minute and retry.');
    if (response.status === 401) throw new Error('Sign in again, or email support@brickbuilder.ai.');
    if (response.status === 422) throw new Error('Check your email and message, then retry.');
    if (!response.ok) throw new Error(failureMessage);
    const body = await response.json().catch(() => null);
    if (body?.sent !== true) throw new Error(failureMessage);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Sending timed out. Retry or email support@brickbuilder.ai.');
    if (error instanceof Error && [failureMessage, 'Too many messages. Wait a minute and retry.', 'Sign in again, or email support@brickbuilder.ai.', 'Check your email and message, then retry.'].includes(error.message)) throw error;
    throw new Error(failureMessage);
  } finally { clearTimeout(timeout); }
}
