import { describe, expect, it } from 'vitest';
import { normalizeEndpoint } from '../scripts/pets/normalize-endpoint.mjs';
import { assertAlphaQuality, assertLoopQuality, measureLoop } from '../scripts/pets/verify-loops.mjs';

// One opaque pixel and one transparent pixel per frame keep the fixtures small.
const frames = (colors: number[], hidden = 0) => new Uint8Array(colors.flatMap(color => [
  color, color, color, 255, hidden, hidden, hidden, 0,
]));

describe('pet loop boundary verification', () => {
  it('accepts a moving animation that returns to its starting pose', () => {
    const metrics = measureLoop(frames([20, 30, 40, 30, 20]), 2, 1);
    expect(metrics.frames).toBe(5);
    expect(metrics.seam_mae).toBe(0);
    expect(metrics.median_step_mae).toBe(10);
    expect(() => assertLoopQuality(metrics)).not.toThrow();
  });

  it('rejects the abrupt pose reset reported on the original animations', () => {
    const metrics = measureLoop(frames([20, 30, 40, 50, 60]), 2, 1);
    expect(metrics.seam_mae).toBe(40);
    expect(() => assertLoopQuality(metrics)).toThrow('Loop jumps');
  });

  it('ignores the RGB values of completely transparent pixels', () => {
    const original = frames([20, 30, 20]);
    const changed = original.slice();
    for (let frame = 0; frame < 3; frame++) changed.fill(frame * 127, frame * 8 + 4, frame * 8 + 7);
    expect(measureLoop(changed, 2, 1)).toEqual(measureLoop(original, 2, 1));
  });

  it('detects alpha discontinuity even when the color layer stays still', () => {
    const rgba = new Uint8Array([50, 50, 50, 255, 50, 50, 50, 200, 50, 50, 50, 100]);
    expect(measureLoop(rgba, 1, 1).seam_mae).toBeGreaterThan(100);
  });

  it('rejects a sudden acceleration next to an otherwise matching boundary', () => {
    const metrics = measureLoop(frames([20, 120, 122, 124, 126, 124, 122, 120, 118, 116, 114, 112, 110, 108, 106, 104, 102, 20]), 2, 1);
    expect(metrics.seam_mae).toBe(0);
    expect(() => assertLoopQuality(metrics)).toThrow('abruptly');
  });

  it('requires a clear background, opaque subject and soft edges in every decoded frame', () => {
    const frame = [0, 0, 0, 0, 0, 255, 255, 128].flatMap(alpha => [50, 50, 50, alpha]);
    const rgba = new Uint8Array([...frame, ...frame, ...frame]);
    const metrics = measureLoop(rgba, 8, 1);
    expect(metrics.alpha_minimum_fraction).toEqual({ clear: 5 / 8, opaque: 2 / 8, soft: 1 / 8 });
    expect(() => assertAlphaQuality(metrics)).not.toThrow();
    rgba[31] = 255; // Remove the only soft edge in the first frame.
    expect(() => assertAlphaQuality(measureLoop(rgba, 8, 1))).toThrow('every frame');
    expect(() => assertAlphaQuality(measureLoop(frames([20, 30, 20]), 2, 1))).toThrow('soft edges');
  });

  it('rejects a frozen clip and invalid or invisible frame data', () => {
    expect(() => assertLoopQuality(measureLoop(frames([20, 20, 20]), 2, 1))).toThrow('static');
    expect(() => measureLoop(new Uint8Array(5), 1, 1)).toThrow('complete RGBA');
    expect(() => measureLoop(new Uint8Array(12), 1, 1)).toThrow('visible subject');
  });
});


describe('tiny endpoint matte correction', () => {
  it('matches the final frame without changing timing, earlier motion, or the input', () => {
    const original = frames([20, 50, 70, 40, 22]);
    const saved = original.slice();
    const corrected = normalizeEndpoint(original, 2, 1, 3);
    expect(original).toEqual(saved);
    expect(corrected.length).toBe(original.length);
    expect(corrected.subarray(0, 24)).toEqual(original.subarray(0, 24));
    expect(corrected.subarray(-8)).toEqual(original.subarray(0, 8));
    expect(measureLoop(corrected, 2, 1).seam_mae).toBe(0);
  });

  it('corrects color in premultiplied space while retaining soft alpha', () => {
    const corrected = normalizeEndpoint(new Uint8Array([
      100, 0, 0, 128, 20, 0, 0, 64, 20, 0, 0, 64,
    ]), 1, 1, 3);
    expect(Array.from(corrected.subarray(4, 8))).toEqual([73, 0, 0, 96]);
    expect(Array.from(corrected.subarray(8))).toEqual([100, 0, 0, 128]);
  });

  it('rejects incomplete frames and correction windows outside the clip', () => {
    expect(() => normalizeEndpoint(new Uint8Array(5), 1, 1, 3)).toThrow('complete RGBA');
    expect(() => normalizeEndpoint(frames([20, 30, 20]), 2, 1, 4)).toThrow('correction window');
    expect(() => normalizeEndpoint(frames([20, 30, 20]), 2, 1, 2)).toThrow('correction window');
  });
});
