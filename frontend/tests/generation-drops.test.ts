import { expect, it, vi } from 'vitest';
import { createGenerationDropLoop, GENERATION_DROP_POOL_SIZE } from '../src/utils/generationDrops';

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

it('clears all 100 pieces before beginning the next batch', () => {
  expect(GENERATION_DROP_POOL_SIZE).toBe(100);
  const events: string[] = [];
  const update = createGenerationDropLoop(index => events.push(`drop ${index}`), GENERATION_DROP_POOL_SIZE, () => events.push('reset'));
  for (let index = 0; index < 100; index++) update(index * 3000);
  expect(events).toHaveLength(100);
  expect(events.at(-1)).toBe('drop 99');
  update(299999);
  expect(events).toHaveLength(100);
  update(300000);
  expect(events.slice(-2)).toEqual(['reset', 'drop 0']);
});
