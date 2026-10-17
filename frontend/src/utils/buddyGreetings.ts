import greetings from '../data/buddy-welcome-greetings.json';

const LAST_GREETING_KEY = 'brickbuilder.last-buddy-greeting';

/** Pick once per visit and avoid repeating the previous visit's greeting. */
export function pickBuddyGreeting(): string {
  let previous = -1;
  try { previous = Number(localStorage.getItem(LAST_GREETING_KEY) ?? -1); } catch { /* Storage is optional. */ }
  const candidates = greetings.length - (Number.isInteger(previous) && previous >= 0 && previous < greetings.length ? 1 : 0);
  let index = Math.floor(Math.random() * candidates);
  if (candidates < greetings.length && index >= previous) index++;
  return greetings[index];
}

export function rememberBuddyGreeting(greeting: string) {
  try { localStorage.setItem(LAST_GREETING_KEY, String(greetings.indexOf(greeting))); } catch { /* Storage is optional. */ }
}

export function formatBuddyGreeting(greeting: string, username?: string | null): string {
  const name = typeof username === 'string' ? username.trim().slice(0, 80) : '';
  return greeting.replace('{name}', name ? `, ${name}` : '');
}
