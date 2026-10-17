import type { Mesh, Object3D, Texture } from 'three';

export type ModelFormat = 'obj' | 'glb';
export const MAX_MODEL_BYTES = 50 * 1024 * 1024;
const MAX_VERTICES = 2_000_000;

export interface ConvertedModel {
  blob: Blob;
  filename: string;
  vertices: number;
  triangles: number;
}

export function validateModelFile(file: File, format: ModelFormat): void {
  if (!file.name.toLowerCase().endsWith(`.${format}`)) throw new Error(`Please select a .${format} file.`);
  if (!file.size || file.size > MAX_MODEL_BYTES) throw new Error('Choose a nonempty model file up to 50 MB.');
}

/** Inspect the container before the loader can resolve any embedded resource URLs. */
export function validateGlb(data: ArrayBuffer): void {
  if (data.byteLength < 20) throw new Error('This file is not a valid GLB 2.0 model.');
  const view = new DataView(data);
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 ||
      view.getUint32(8, true) !== data.byteLength || view.getUint32(16, true) !== 0x4e4f534a ||
      jsonLength > data.byteLength - 20 || jsonLength % 4 !== 0) {
    throw new Error('This file is not a valid GLB 2.0 model.');
  }
  let json;
  try {
    json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, jsonLength)));
  } catch {
    throw new Error('This file is not a valid GLB 2.0 model.');
  }
  if (!json || typeof json !== 'object') throw new Error('This file is not a valid GLB 2.0 model.');
  if (json.asset?.version !== '2.0') throw new Error('This file is not a valid GLB 2.0 model.');
  // A standalone conversion must never fetch URLs supplied by an uploaded model.
  for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
    if (resource.uri && !/^data:/i.test(resource.uri)) {
      throw new Error('This GLB references external files. Export a self-contained GLB with embedded resources first.');
    }
  }
}

export function inspectModel(scene: Object3D): { vertices: number; triangles: number } {
  let vertices = 0;
  let triangles = 0;
  scene.updateMatrixWorld(true);
  scene.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    if ('isSkinnedMesh' in mesh || 'isInstancedMesh' in mesh || Object.keys(mesh.geometry.morphAttributes).length) {
      throw new Error('Export a static mesh with skinning, instances, and shape keys applied before converting.');
    }
    const position = mesh.geometry.getAttribute('position');
    if (!position || !position.count) return;
    vertices += position.count;
    if (vertices > MAX_VERTICES) throw new Error('This model is too complex. Simplify it to fewer than 2 million vertices.');
    for (const attribute of Object.values(mesh.geometry.attributes)) {
      for (let i = 0; i < attribute.array.length; i++) {
        if (!Number.isFinite(attribute.array[i])) throw new Error('The model contains invalid geometry. Re-export it and try again.');
      }
    }
    const index = mesh.geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i++) {
        const value = index.getX(i);
        if (!Number.isInteger(value) || value < 0 || value >= position.count) throw new Error('The model contains invalid face indices.');
      }
    }
    const count = index?.count ?? position.count;
    if (count % 3) throw new Error('The model must contain triangle mesh faces.');
    if (!mesh.matrixWorld.elements.every(Number.isFinite)) throw new Error('The model contains an invalid transform.');
    triangles += count / 3;
    // OBJ names are line-based; prevent source names from introducing new directives.
    mesh.name = mesh.name.replace(/[\r\n]/g, ' ');
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.name = material.name.replace(/[\r\n]/g, ' ');
  });
  if (!triangles) throw new Error('No mesh faces were found. Choose a 3D model with polygon faces.');
  return { vertices, triangles };
}

function disposeModel(scene: Object3D): void {
  const textures = new Set<Texture>();
  scene.traverse(object => {
    const mesh = object as Mesh;
    if (!mesh.geometry) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && typeof value === 'object' && 'isTexture' in value) textures.add(value as Texture);
      }
      material.dispose();
    }
  });
  textures.forEach(texture => {
    texture.dispose();
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close();
  });
}

export async function convertModelFormat(file: File, inputFormat: ModelFormat): Promise<ConvertedModel> {
  validateModelFile(file, inputFormat);
  let scene: Object3D;
  if (inputFormat === 'obj') {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    const text = (await file.text()).replace(/\\\r?\n/g, '');
    // OBJLoader logs unknown source lines. Reject them before parsing so replay
    // console capture cannot collect text from a visitor's model file.
    const directives = new Set(['v', 'vn', 'vt', 'f', 'l', 'p', 'o', 'g', 's', 'usemtl', 'mtllib', 'usemap']);
    for (const [, directive] of text.matchAll(/^\s*(\S+)/gm)) {
      if (!directive.startsWith('#') && !directives.has(directive)) {
        throw new Error('This OBJ contains unsupported data. Re-export it as a polygon mesh and try again.');
      }
    }
    try {
      scene = new OBJLoader().parse(text);
    } catch {
      throw new Error('Could not read this OBJ. Re-export a standalone Wavefront mesh and try again.');
    }
  } else {
    const data = await file.arrayBuffer();
    validateGlb(data);
    const [{ LoadingManager }, { GLTFLoader }] = await Promise.all([
      import('three'), import('three/examples/jsm/loaders/GLTFLoader.js'),
    ]);
    const manager = new LoadingManager();
    manager.setURLModifier(url => {
      if (!/^(?:data:|blob:)/i.test(url)) throw new Error('External model resources are not supported.');
      return url;
    });
    try {
      scene = (await new GLTFLoader(manager).parseAsync(data, '')).scene;
    } catch {
      throw new Error('Could not read this GLB. Try exporting an uncompressed, self-contained GLB 2.0 model.');
    }
  }
  try {
    const stats = inspectModel(scene);
    const outputFormat = inputFormat === 'obj' ? 'glb' : 'obj';
    const basename = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100) || 'model';
    let output: ArrayBuffer | string;
    if (inputFormat === 'obj') {
      const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
      output = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false }) as ArrayBuffer;
    } else {
      const { OBJExporter } = await import('three/examples/jsm/exporters/OBJExporter.js');
      output = new OBJExporter().parse(scene);
    }
    return {
      blob: new Blob([output], { type: outputFormat === 'glb' ? 'model/gltf-binary' : 'text/plain;charset=utf-8' }),
      filename: `${basename}.${outputFormat}`,
      ...stats,
    };
  } finally {
    disposeModel(scene);
  }
}
