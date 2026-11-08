import { expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { createObjectExport } from '../src/utils/objectExport';

const model = `0 FILE main.ldr
0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333
0 !COLOUR Blue CODE 1 VALUE #0055BF EDGE #333333
1 4 20 0 0 1 0 0 0 1 0 0 0 1 brick.dat
1 1 0 0 0 1 0 0 0 1 0 0 0 1 brick.dat
0 FILE brick.dat
0 !LDRAW_ORG Part
0 BFC CERTIFY CCW
3 16 0 0 0 20 0 0 0 -20 0
2 24 0 0 0 20 0 0`;
const read = (blob: Blob): Promise<ArrayBuffer> => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob);
});

it('packages OBJ with linked MTL colors, transformed placements and no edge lines', async () => {
  const result = await createObjectExport(model, '../My model', 'obj');
  expect(result.filename).toBe('My_model_obj.zip');
  const zip = unzipSync(new Uint8Array(await read(result.blob)));
  const obj = strFromU8(zip['My_model.obj']);
  const mtl = strFromU8(zip['My_model.mtl']);
  expect(obj).toContain('mtllib My_model.mtl');
  expect(obj).toContain('v 16 0 0');
  expect(obj.match(/^f /gm)).toHaveLength(2);
  expect(obj).not.toMatch(/^l /m);
  for (const match of obj.matchAll(/^usemtl (.+)$/gm)) expect(mtl).toContain(`newmtl ${match[1]}`);
  expect(mtl.match(/^newmtl /gm)).toHaveLength(2);
  expect(Number(mtl.match(/Kd ([\d.]+)/)?.[1])).toBeCloseTo(201 / 255, 4);
});

it('exports binary STL at physical millimeter scale, Z-up and on the print bed', async () => {
  const result = await createObjectExport(model, 'Model', 'stl');
  expect(result.filename).toBe('Model.stl');
  const data = new DataView(await read(result.blob));
  expect(data.getUint32(80, true)).toBe(2);
  expect(data.byteLength).toBe(184);
  const points: number[][] = [];
  for (let face = 0; face < 2; face++) for (let v = 0; v < 3; v++) {
    points.push([0, 1, 2].map(axis => data.getFloat32(84 + face * 50 + 12 + v * 12 + axis * 4, true)));
  }
  expect(Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]))).toBeCloseTo(16);
  expect(Math.min(...points.map(p => p[2]))).toBeCloseTo(0);
  expect(Math.max(...points.map(p => p[2]))).toBeCloseTo(8);
});

it('exports a self-contained GLB with materials, triangles and meter scaling', async () => {
  const result = await createObjectExport(model, 'Model', 'glb');
  const buffer = await read(result.blob);
  const data = new DataView(buffer);
  expect(data.getUint32(0, true)).toBe(0x46546c67);
  expect(data.getUint32(4, true)).toBe(2);
  expect(data.getUint32(8, true)).toBe(buffer.byteLength);
  const json = JSON.parse(strFromU8(new Uint8Array(buffer, 20, data.getUint32(12, true))));
  expect(json.materials).toHaveLength(2);
  expect(json.buffers[0].uri).toBeUndefined();
  expect(json.nodes.some((node: { matrix?: number[] }) => node.matrix && Math.abs(node.matrix[0] - 0.0004) < 1e-9)).toBe(true);
  expect(json.meshes.flatMap((mesh: { primitives: unknown[] }) => mesh.primitives)).toHaveLength(2);
});

it('rejects missing geometry and empty models rather than exporting incomplete files', async () => {
  await expect(createObjectExport('1 4 0 0 0 1 0 0 0 1 0 0 0 1 https://example.com/part.dat', 'Model', 'stl')).rejects.toThrow('missing packed');
  await expect(createObjectExport('0 Empty', 'Model', 'obj')).rejects.toThrow('No 3D geometry');
});

it('exports the shipped packed house model without external part requests', async () => {
  const { readFileSync } = await import('node:fs');
  const packed = readFileSync('public/assets/ldraw-generation-scenes/house.mpd', 'utf8');
  const result = await createObjectExport(packed, 'House', 'stl');
  const data = new DataView(await read(result.blob));
  expect(data.getUint32(80, true)).toBeGreaterThan(100);
  expect(data.byteLength).toBe(84 + 50 * data.getUint32(80, true));
});
