export const BUILD_FAILURE_MESSAGE = 'Oops! I couldn’t make your build. Please try again.';

export const GUEST_GENERATION_LIMIT_MESSAGE = 'You have used your 3 free guest generations. Sign in to keep building.';

// Quota errors are actionable public messages; keep infrastructure errors generic.
export function buildFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : error;
  if (typeof message === 'string' && message.startsWith('You have used your available credits.')) return 'You’re out of BrickBuilder credits.';
  if (message === 'Generation cancelled. Your AI account was not charged.') return message;
  if (typeof message === 'string' && /^Add your (OpenAI|Claude|openai|anthropic) API key in AI billing settings, or (choose BrickBuilder credits|select BrickBuilder credits)\.$/.test(message)) return message;
  return typeof message === 'string' && (/^You have reached the daily limit of ([1-9]|[12][0-9]|30) generations\. Please wait until /.test(message)
    || message === GUEST_GENERATION_LIMIT_MESSAGE
    || message === 'You can only have one generation running at a time. Wait for it to finish or cancel it before starting another.')
    ? message : BUILD_FAILURE_MESSAGE;
}

/** Condense the latest streamed activity; never display the full reasoning log. */
export function summarizeBuildProgress(notes: string, fallback = 'Planning your build'): string {
  const phrases = notes.slice(-4000).replace(/```[\s\S]*?(?:```|$)/g, '')
    .split(/\n+|[.!?]\s+/)
    .map(line => line.replace(/^[\s#>*\-]+/, '').replace(/[*_\x60]/g, '').trim())
    .filter(line => /[a-z]/i.test(line) && !/^[{\[\d]|^\s*"[^"\n]+"\s*:/.test(line));
  const latest = [...phrases].reverse().find(line => line.split(/\s+/).length >= 3) ?? phrases.at(-1);
  if (!latest) return fallback;
  const action = latest.match(/\b(?:checking|preparing|building|designing|adding|adjusting|choosing|coloring|colouring|connecting|refining|shaping|creating|placing|planning|reviewing|finishing|applying|assembling|packing|saving|rendering)\b.*$/i)?.[0] ?? latest;
  const summary = action.replace(/[.!…]+$/, '').split(/\s+/).slice(0, 8).join(' ').replace(/[,;:]$/, '');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
