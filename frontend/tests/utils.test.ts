import { describe, expect, it } from 'vitest';
import {
  clearAnonymousGenerationIds,
  getAnonymousGenerationIds,
  recordAnonymousGeneration,
  removeAnonymousGenerationId,
} from '../src/utils/anonGenerations';
import { getColorName, getColorNameWithFallback, parseLDrawColors } from '../src/utils/colorParser';
import { LDrawParser } from '../src/utils/ldrawParser';
import { getLlmEditMaxSegmentationRounds, LLM_EDIT_REASONING_OPTIONS } from '../src/utils/llmEditReasoning';
import { LDrawPacker } from '../src/utils/ldrawPacker';

const part = (color: number, x: number, y: number, z: number, name = '3001.dat') =>
  `1 ${color} ${x} ${y} ${z} 1 0 0 0 1 0 0 0 1 ${name}`;

describe('anonymous generation storage', () => {
  it('records unique valid ids and removes or clears them', () => {
    recordAnonymousGeneration(undefined);
    recordAnonymousGeneration('a');
    recordAnonymousGeneration('a');
    recordAnonymousGeneration('b');
    expect(getAnonymousGenerationIds()).toEqual(['a', 'b']);
    removeAnonymousGenerationId('a');
    expect(getAnonymousGenerationIds()).toEqual(['b']);
    clearAnonymousGenerationIds();
    expect(getAnonymousGenerationIds()).toEqual([]);
  });

  it('tolerates malformed and non-array storage values', () => {
    localStorage.setItem('anon_generation_ids_v2', '{');
    expect(getAnonymousGenerationIds()).toEqual([]);
    localStorage.setItem('anon_generation_ids_v2', JSON.stringify(['ok', 1, null]));
    expect(getAnonymousGenerationIds()).toEqual(['ok']);
  });
});

describe('color parser', () => {
  it('parses valid definitions, optional edges, and ignores malformed lines', () => {
    const colors = parseLDrawColors([
      '0 !COLOUR Dark_Blue CODE 272 VALUE #19325A EDGE #101010',
      '0 !COLOUR Red CODE 4 VALUE #C91A09',
      '0 !COLOUR Broken CODE x VALUE nope',
    ].join('\n'));
    expect(colors.get(272)).toEqual({ code: 272, name: 'Dark Blue', value: '#19325A', edge: '#101010' });
    expect(colors.get(4)?.edge).toBe('#C91A09');
    expect(colors.size).toBe(2);
    expect(getColorName(272, colors)).toBe('Dark Blue');
    expect(getColorName(99, colors)).toBe('Color 99');
    expect(getColorNameWithFallback(4)).toBe('Red');
    expect(getColorNameWithFallback(999, colors)).toBe('Color 999');
  });
});

describe('LDraw parser and packer', () => {
  it('parses steps, parts, bounds, quantities, and regenerates MPDs', () => {
    const model = LDrawParser.parseLDRContent([
      '0 model', part(4, -2, 3, 7), part(4, 5, 1, 9), '0 STEP', part(1, 0, -4, 2, '3003.dat'),
    ].join('\n'), 'robot.ldr');
    expect(model.name).toBe('robot');
    expect(model.parts).toHaveLength(3);
    expect(model.steps.map((step) => step.parts.length)).toEqual([2, 1]);
    expect(model.boundingBox).toEqual({ min: { x: -2, y: -4, z: 2 }, max: { x: 5, y: 3, z: 9 } });
    expect(LDrawParser.getPartsListForStep(model.steps[0])).toEqual([
      { filename: '3001.dat', quantity: 2, colorCode: 4 },
    ]);
    expect(LDrawParser.convertToMPD(model)).toContain('0 FILE robot.ldr');
    expect(LDrawParser.generateStepMPDs(model)[1].mpdContent).toContain('3003.dat');
    expect(LDrawParser.calculateBoundingBox([])).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } });
  });

  it('ignores incomplete part records and packs normalized LDR content', async () => {
    const empty = LDrawParser.parseLDRContent('1 4 0 0');
    expect(empty.parts).toEqual([]);
    const packed = await LDrawPacker.packLDrawContent(`${part(4, 0, 0, 0)}\r\n0 STEP`, 'demo.ldr');
    expect(packed.success).toBe(true);
    expect(packed.packedContent).toContain('0 !COLOUR Black');
    expect(packed.packedContent).toContain('3001.dat\n0 STEP');
    await expect(LDrawPacker.convertLdrToMpd(part(4, 0, 0, 0), 'demo')).resolves.toContain('3001.dat');
  });
});

describe('LLM edit reasoning', () => {
  it('maps low, medium, and high reasoning to segmentation rounds', () => {
    expect(LLM_EDIT_REASONING_OPTIONS).toEqual([
      { label: 'Low', value: 'low', maxSegmentationRounds: 1 },
      { label: 'Medium', value: 'medium', maxSegmentationRounds: 2 },
      { label: 'High', value: 'high', maxSegmentationRounds: 3 },
    ]);
    expect(getLlmEditMaxSegmentationRounds('low')).toBe(1);
    expect(getLlmEditMaxSegmentationRounds('medium')).toBe(2);
    expect(getLlmEditMaxSegmentationRounds('high')).toBe(3);
  });
});
