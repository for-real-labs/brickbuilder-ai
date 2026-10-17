import type { BuddyTurn } from '../hooks/useBuildBuddyChat';

/** A single next step from the current conversation; no rotating examples. */
export function buddyPromptSuggestion(turns: BuddyTurn[], petName: string, modelSuggestion?: string): string {
  const latest = turns[turns.length - 1];
  if (latest?.error) return 'Try your message again…';
  if (latest?.kind === 'upload') return 'Add details for the image you’d like to build…';
  if (latest?.buildPrompt) return latest.buildPrompt;
  const questions = latest?.reply?.match(/[^.!?\n]+\?/gu);
  const question = questions?.[questions.length - 1]?.trim();
  if (question) return question.slice(0, 160);
  if (latest?.kind === 'gift') return 'Tell me who the gift is for and what they love…';
  if (modelSuggestion) return modelSuggestion;
  const topic = latest?.text.trim().replace(/\s+/gu, ' ').replace(/[.!?…]+$/u, '').slice(0, 100);
  if (topic) return `Tell me more about “${topic}”…`;
  return `Tell ${petName} more about your idea…`;
}
