import { beforeEach, expect, it, vi } from 'vitest';
import { recentModelFacts, rememberModelFact } from '../src/utils/buddyModelFacts';

beforeEach(() => localStorage.clear());

it('remembers recent facts per model across visits without saving fallback copy', () => {
  rememberModelFact('truck', 'Did you know garbage trucks can squeeze trash?');
  rememberModelFact('castle', 'Fun fact: castles often had thick walls!');
  rememberModelFact('truck', 'Here’s something neat: garbage trucks use strong compactors!');
  rememberModelFact('truck', 'Here’s truck!');
  expect(recentModelFacts('truck')).toEqual([
    'Did you know garbage trucks can squeeze trash?',
    'Here’s something neat: garbage trucks use strong compactors!',
  ]);
  expect(recentModelFacts('castle')).toEqual(['Fun fact: castles often had thick walls!']);
});

it('bounds saved facts and tolerates corrupt or unavailable storage', () => {
  for (let index = 0; index < 10; index++) rememberModelFact('truck', `Fun fact: detail ${index}!`);
  expect(recentModelFacts('truck')).toHaveLength(8);
  localStorage.setItem('brickbuilder.model-fact-history', '{bad json');
  expect(recentModelFacts('truck')).toEqual([]);
  expect(recentModelFacts('__proto__')).toEqual([]);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  expect(recentModelFacts('truck')).toEqual([]);
  expect(() => rememberModelFact('truck', 'Fun fact: trucks have wheels!')).not.toThrow();
  vi.restoreAllMocks();
});
