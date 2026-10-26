import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { getPartName, parsePartNames } from '../src/utils/partNames';

it('uses English library descriptions for slopes, plates, and uncommon parts', () => {
  const names = parsePartNames(`0 FILE model.ldr
0 My model
0 FILE parts/2304.dat
0 Baseplate  24 x  43
0 Name: 2304.dat
0 FILE parts/3039.dat
0 Slope Brick 45 2 x 2
0 FILE parts/3020.dat
0 Plate 2 x 4
`);
  expect(getPartName('2304.dat', names)).toBe('Baseplate 24x43');
  expect(getPartName('PARTS\\3039.DAT', names)).toBe('Slope Brick 45 2x2');
  expect(getPartName('parts/3020', names)).toBe('Plate 2x4');
});

it('reads descriptions from a real packed model', () => {
  const names = parsePartNames(readFileSync('public/assets/ldraw-generation-scenes/house.mpd', 'utf8'));
  expect(getPartName('3001.dat', names)).toBe('Brick 2x4');
  expect(getPartName('3020.dat', names)).toBe('Plate 2x4');
});

it('never displays metadata or filenames when a description is unavailable', () => {
  const names = parsePartNames('0 FILE custom.dat\r\n0 !LDRAW_ORG Unofficial_Part\r\n0 Author: Someone\r\n0 FILE other.dat\n0 Name: other.dat\n');
  expect(getPartName('custom.dat', names)).toBe('Custom part');
  expect(getPartName('other.dat', names)).toBe('Custom part');
  expect(getPartName('PARTS/3001.DAT', names)).toBe('2x4');
  expect(getPartName('toString.dat', names)).toBe('Custom part');
});
