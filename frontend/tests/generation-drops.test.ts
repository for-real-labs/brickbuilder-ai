import { expect, it, vi } from 'vitest';
import { createGenerationDropLoop } from '../src/utils/generationDrops';

it('drops immediately and every three seconds, recycling the bounded pool', () => {
  const drop = vi.fn();
  const update = createGenerationDropLoop(drop, 2);
  update(100);
  update(3099);
  expect(drop.mock.calls).toEqual([[0]]);
  update(3100);
  update(6099);
  expect(drop.mock.calls).toEqual([[0], [1]]);
  update(6100);
  expect(drop.mock.calls).toEqual([[0], [1], [0]]);
});

it('does not burst after a background pause or spawn from an empty pool', () => {
  const drop = vi.fn();
  const update = createGenerationDropLoop(drop, 24);
  update(0);
  update(60_000);
  update(60_001);
  expect(drop).toHaveBeenCalledTimes(2);
  createGenerationDropLoop(drop, 0)(100_000);
  expect(drop).toHaveBeenCalledTimes(2);
});

it('clears all 30 pieces before beginning the next batch', () => {
  const events: string[] = [];
  const update = createGenerationDropLoop(index => events.push(`drop ${index}`), 30, () => events.push('reset'));
  for (let index = 0; index < 30; index++) update(index * 3000);
  expect(events).toHaveLength(30);
  expect(events.at(-1)).toBe('drop 29');
  update(89999);
  expect(events).toHaveLength(30);
  update(90000);
  expect(events.slice(-2)).toEqual(['reset', 'drop 0']);
});
