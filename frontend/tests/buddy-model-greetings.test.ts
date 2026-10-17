import { expect, it, vi } from 'vitest';
import { MODEL_GREETINGS, pickModelGreeting, rememberModelGreeting } from '../src/utils/buddyModelGreetings';

it('offers varied compliments with an invitation to edit or order delivery', () => {
  expect(new Set(MODEL_GREETINGS).size).toBeGreaterThan(1);
  for (const message of MODEL_GREETINGS) {
    expect(message).toMatch(/build.*!/i);
    expect(message).toMatch(/edit|change/);
    expect(message).toContain('order button');
    expect(message).toContain('delivered');
  }
});

it('avoids consecutive repeats and handles invalid saved greetings', () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const first = pickModelGreeting();
  rememberModelGreeting(first);
  expect(pickModelGreeting()).not.toBe(first);
  localStorage.setItem('brickbuilder.last-model-greeting', 'invalid');
  expect(MODEL_GREETINGS).toContain(pickModelGreeting());
});

it('still greets visitors when browser storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  const message = pickModelGreeting();
  expect(MODEL_GREETINGS).toContain(message);
  expect(() => rememberModelGreeting(message)).not.toThrow();
});
