const LAST_MODEL_GREETING_KEY = 'brickbuilder.last-model-greeting';

export const MODEL_GREETINGS = [
  'Tell me if you want to edit this model, or click the order button to get it delivered!',
  'Tell me what you’d like to edit, or click the order button to have this model delivered!',
  'Tell me if you’d like to edit anything, or click the order button to get it delivered!',
  'Tell me how you’d like to edit it, or click the order button to have it delivered!',
  'Tell me if you want to edit it, or click the order button to get this model delivered!',
  'Tell me what you’d like to edit, or click the order button to get it delivered!',
];

/** Keep the message stable for a displayed build and vary it across visits. */
export function pickModelGreeting(): string {
  let previous = -1;
  try { previous = Number(localStorage.getItem(LAST_MODEL_GREETING_KEY) ?? -1); } catch { /* Storage is optional. */ }
  const hasPrevious = Number.isInteger(previous) && previous >= 0 && previous < MODEL_GREETINGS.length;
  let index = Math.floor(Math.random() * (MODEL_GREETINGS.length - (hasPrevious ? 1 : 0)));
  if (hasPrevious && index >= previous) index++;
  return MODEL_GREETINGS[index];
}

export function rememberModelGreeting(greeting: string) {
  try { localStorage.setItem(LAST_MODEL_GREETING_KEY, String(MODEL_GREETINGS.indexOf(greeting))); } catch { /* Storage is optional. */ }
}
