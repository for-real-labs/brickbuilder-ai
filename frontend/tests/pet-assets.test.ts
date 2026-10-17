import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PETS, petVideoPath, petVideoSources } from '../src/pets';

it.each(PETS)('ships $name artwork and every animation without a remote runtime dependency', pet => {
  const asset = (path: string) => resolve(process.cwd(), 'public', path.slice(1));
  const poster = readFileSync(asset(`/pets/${pet.id}.webp`));
  expect(poster.subarray(8, 12).toString()).toBe('WEBP');
  for (const state of ['idle', 'building', 'celebrating'] as const) {
    const path = asset(petVideoPath(pet.id, state));
    const header = readFileSync(path);
    expect(path.endsWith('-alpha.webm')).toBe(true);
    expect(header.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    expect(header.includes(Buffer.from('ALPHA_MODE'))).toBe(true);
    expect(statSync(path).size).toBeLessThan(650_000);
  }
});

// HEVC stores color and alpha as separate layers in the same track. Checking
// both parameter-set layers catches an accidental opaque-only transcode.
it.each(PETS)('ships Safari HEVC color and alpha layers for every $name animation', pet => {
  for (const state of ['idle', 'building', 'celebrating'] as const) {
    const sources = petVideoSources(pet.id, state);
    expect(petVideoSources(pet.id, 'listening')).toEqual(petVideoSources(pet.id, 'idle'));
    const path = resolve(process.cwd(), 'public', sources[0].src.slice(1));
    const data = readFileSync(path);
    expect(data.subarray(4, 8).toString()).toBe('ftyp');
    expect(data.includes(Buffer.from('hvc1'))).toBe(true);
    const config = data.indexOf(Buffer.from('hvcC'));
    expect(config).toBeGreaterThan(0);
    const header = data.subarray(config + 4);
    const layers = new Set<number>();
    let offset = 23;
    for (let array = 0; array < header[22]; array++) {
      const count = header.readUInt16BE(offset + 1);
      offset += 3;
      for (let unit = 0; unit < count; unit++) {
        const length = header.readUInt16BE(offset);
        offset += 2;
        layers.add(((header[offset] & 1) << 5) | (header[offset + 1] >> 3));
        offset += length;
      }
    }
    expect(layers.has(0)).toBe(true);
    expect(layers.has(1)).toBe(true);
    expect(statSync(path).size).toBeLessThan(1_200_000);
  }
});
