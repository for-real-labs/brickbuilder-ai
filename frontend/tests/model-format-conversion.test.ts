// @vitest-environment node
import { BufferAttribute, BufferGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial } from 'three';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { convertModelFormat, inspectModel, MAX_MODEL_BYTES, validateGlb, validateModelFile } from '../src/services/modelFormatConversion';

vi.stubGlobal('localStorage', { clear() {} });

// GLTFExporter uses browser FileReader; exercise its real binary writer in Node.
class TestFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend?: () => void;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then(value => { this.result = value; this.onloadend?.(); });
  }
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(value => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
beforeAll(() => vi.stubGlobal('FileReader', TestFileReader));
afterAll(() => vi.unstubAllGlobals());

const triangle = 'v 0 0 0 1 0 0\nv 1 0 0 0 1 0\nv 0 1 0 0 0 1\nvt 0 0\nvt 1 0\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1\n';
function glbJson(data: ArrayBuffer) {
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, new DataView(data).getUint32(12, true))));
}
function jsonGlb(json: object): ArrayBuffer {
  const source = new TextEncoder().encode(JSON.stringify(json));
  const length = Math.ceil(source.length / 4) * 4;
  const data = new ArrayBuffer(20 + length);
  const view = new DataView(data);
  [0x46546c67, 2, data.byteLength, length, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
  new Uint8Array(data, 20).fill(32);
  new Uint8Array(data, 20, source.length).set(source);
  return data;
}

it('writes a valid GLB with geometry, normals, UVs, and embedded vertex colors from a real OBJ', async () => {
  const result = await convertModelFormat(new File([triangle], 'my model.OBJ'), 'obj');
  expect(result.filename).toBe('my_model.glb');
  expect(result.blob.type).toBe('model/gltf-binary');
  expect(result.vertices).toBe(3);
  expect(result.triangles).toBe(1);
  const data = await result.blob.arrayBuffer();
  validateGlb(data);
  const json = glbJson(data);
  expect(json.meshes[0].primitives[0].attributes).toEqual(expect.objectContaining({
    POSITION: expect.any(Number), NORMAL: expect.any(Number), TEXCOORD_0: expect.any(Number), COLOR_0: expect.any(Number),
  }));
  expect(json.buffers[0].uri).toBeUndefined();
});

it('round-trips a real GLB to OBJ mesh geometry without network requests', async () => {
  const first = await convertModelFormat(new File([triangle], 'triangle.obj'), 'obj');
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    const result = await convertModelFormat(new File([first.blob], 'triangle.glb'), 'glb');
    expect(result.filename).toBe('triangle.obj');
    const obj = await result.blob.text();
    expect(obj).toContain('v 1 0 0');
    expect(obj).toContain('vt 1 0');
    expect(obj).toContain('vn 0 0 1');
    expect(obj).toContain('f 1/1/1 2/2/2 3/3/3');
    expect(result.triangles).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

it('rejects external resource URLs before loading any GLB data', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  try {
    for (const key of ['buffers', 'images']) {
      for (const uri of ['https://example.com/private', '/api/internal', 'file:///tmp/model', 'blob:untrusted']) {
        const data = jsonGlb({ asset: { version: '2.0' }, [key]: [{ uri }] });
        await expect(convertModelFormat(new File([data], 'model.glb'), 'glb')).rejects.toThrow('external files');
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});

it('rejects truncated GLB containers, invalid headers, and a mismatched declared length', () => {
  for (const data of [new ArrayBuffer(0), new ArrayBuffer(20), jsonGlb({ asset: { version: '1.0' } })]) {
    expect(() => validateGlb(data)).toThrow('valid GLB 2.0');
  }
  const data = jsonGlb({ asset: { version: '2.0' } });
  new DataView(data).setUint32(8, 999, true);
  expect(() => validateGlb(data)).toThrow('valid GLB 2.0');
});

it('returns safe errors for malformed GLB JSON without exposing its source text', () => {
  const data = jsonGlb({ asset: { version: '2.0' }, confidential: 'private design' });
  new Uint8Array(data, 20)[0] = 33;
  expect(() => validateGlb(data)).toThrow('This file is not a valid GLB 2.0 model.');
  expect(() => validateGlb(jsonGlb(null as unknown as object))).toThrow('valid GLB 2.0');
});

it('rejects unsupported OBJ statements without logging source text and accepts continued faces', async () => {
  await expect(convertModelFormat(new File(['confidential design notes'], 'model.obj'), 'obj')).rejects.toThrow('unsupported data');
  expect(console.warn).not.toHaveBeenCalled();
  const result = await convertModelFormat(new File(['# a model\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 \\\n3\n'], 'model.obj'), 'obj');
  expect(result.triangles).toBe(1);
});

it('rejects empty, oversized, wrong-format, faceless, and invalid OBJ inputs', async () => {
  expect(() => validateModelFile(new File([], 'model.obj'), 'obj')).toThrow('nonempty');
  expect(() => validateModelFile(new File(['mesh'], 'model.glb'), 'obj')).toThrow('.obj file');
  expect(() => validateModelFile({ name: 'model.obj', size: MAX_MODEL_BYTES + 1 } as File, 'obj')).toThrow('50 MB');
  for (const contents of ['v 0 0 0\n', 'v 0 0 0\nv 1 0 0\nf 1 2 999\n', 'v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n']) {
    await expect(convertModelFormat(new File([contents], 'model.obj'), 'obj')).rejects.toThrow();
  }
});

it('validates face indices and rejects instances instead of silently omitting their transforms', () => {
  const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3));
  const material = new MeshStandardMaterial();
  const scene = new Group();
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  geometry.setIndex([0, 1, 99]);
  expect(() => inspectModel(scene)).toThrow('invalid face indices');
  geometry.setIndex([0, 1, 2]);
  scene.add(new InstancedMesh(geometry, material, 1));
  expect(() => inspectModel(scene)).toThrow('static mesh');
});

it('applies nested world transforms and sanitizes source object names in OBJ exports', async () => {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array([0,0,0, 1,0,0, 0,1,0]), 3));
  const scene = new Group();
  scene.position.x = 5;
  const mesh = new Mesh(geometry, new MeshStandardMaterial());
  mesh.name = 'model\nf 999 999 999';
  mesh.position.y = 2;
  scene.add(mesh);
  const data = await new GLTFExporter().parseAsync(scene, { binary: true }) as ArrayBuffer;
  const result = await convertModelFormat(new File([data], 'model.glb'), 'glb');
  const obj = await result.blob.text();
  expect(obj).toContain('v 5 2 0');
  expect(obj).toContain('v 6 2 0');
  expect(obj.split('\n').filter(line => line.startsWith('f '))).toHaveLength(1);
  geometry.dispose();
});
