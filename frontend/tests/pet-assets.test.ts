import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PETS, petVideoPath } from '../src/pets';

it.each(PETS)('ships $name artwork and every animation without a remote runtime dependency', pet => {
  const asset = (path: string) => resolve(process.cwd(), 'public', path.slice(1));
  const poster = readFileSync(asset(`/pets/${pet.id}.webp`));
  expect(poster.subarray(8, 12).toString()).toBe('WEBP');
  for (const state of ['idle', 'building', 'celebrating'] as const) {
    const path = asset(petVideoPath(pet.id, state));
    const header = readFileSync(path);
    if (path.endsWith('.webm')) {
      expect(header.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
      expect(header.includes(Buffer.from('ALPHA_MODE'))).toBe(true);
    }
    else expect(header.subarray(4, 8).toString()).toBe('ftyp');
    expect(statSync(path).size).toBeLessThan(650_000);
  }
});
