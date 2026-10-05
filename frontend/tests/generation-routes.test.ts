import { describe, expect, it } from 'vitest';
import {
  getGeneratedModelPath,
  getOrderReturnModelPath,
} from '../src/utils/generationRoutes';

describe('generation routes', () => {
  it('builds a generated model path for a history entry', () => {
    expect(getGeneratedModelPath('generation-123')).toBe(
      '/generated-model?id=generation-123',
    );
  });

  it('encodes generation IDs before adding them to the query string', () => {
    expect(getGeneratedModelPath('generation?id=123')).toBe(
      '/generated-model?id=generation%3Fid%3D123',
    );
  });

  it('opens a completed revision exactly without resuming the pending edit', () => {
    expect(getGeneratedModelPath('completed?id=2', true)).toBe(
      '/generated-model?id=completed%3Fid%3D2&exact=1',
    );
  });

  it('returns from the order page to the generation supplied in navigation state', () => {
    expect(getOrderReturnModelPath('order-generation', 'last-generation')).toBe(
      '/generated-model?id=order-generation',
    );
  });

  it('falls back to the last generation when order navigation state is unavailable', () => {
    expect(getOrderReturnModelPath(undefined, 'last-generation')).toBe(
      '/generated-model?id=last-generation',
    );
  });

  it('preserves the generated model fallback when no generation ID is known', () => {
    expect(getOrderReturnModelPath(undefined, null)).toBe('/generated-model');
  });
});
