import * as THREE from 'three';

const INSTANCE_THRESHOLD = 1000;

export interface LDrawInstancePlan {
  content: string;
  templates: { file: string; matrices: THREE.Matrix4[]; inverted: boolean; color: string }[];
  partCount: number;
}

/** Parse each repeated library part only once, before LDrawLoader allocates its faces. */
export function planLDrawInstances(content: string): LDrawInstancePlan | null {
  const lines = content.split(/\r?\n/);
  const colors: string[] = [];
  const templates: LDrawInstancePlan['templates'] = [];
  const byPart = new Map<string, number>();
  let rootFile = false;
  let partCount = 0;
  let end = lines.length;
  let inverted = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (/^0\s+FILE\s/i.test(line)) {
      if (rootFile || partCount) { end = index; break; }
      rootFile = true;
    } else if (/^0\s+!COLOUR\s/i.test(line)) colors.push(line);
    else if (/^0\s+BFC\s+INVERTNEXT$/i.test(line)) inverted = true;
    else if (/^[2-5]\s/.test(line)) return null;
    else if (/^1\s/.test(line)) {
      const fields = line.split(/\s+/);
      const file = fields.slice(14).join(' ').replace(/\\/g, '/');
      const values = fields.slice(2, 14).map(Number);
      // Hierarchical models and instruction steps keep their existing loader.
      if (!/\.dat$/i.test(file) || values.length !== 12 || !values.every(Number.isFinite)) return null;
      const matrix = new THREE.Matrix4().set(
        values[3], values[4], values[5], values[0],
        values[6], values[7], values[8], values[1],
        values[9], values[10], values[11], values[2],
        0, 0, 0, 1,
      );
      const key = `${fields[1]}:${file.toLowerCase()}:${inverted}`;
      let slot = byPart.get(key);
      if (slot === undefined) {
        slot = templates.length;
        byPart.set(key, slot);
        templates.push({ file, matrices: [], color: fields[1], inverted });
      }
      templates[slot].matrices.push(matrix);
      partCount++;
      inverted = false;
    }
  }
  if (partCount < INSTANCE_THRESHOLD) return null;
  const references = templates.map(part => `${part.inverted ? '0 BFC INVERTNEXT\n' : ''}1 ${part.color} 0 0 0 1 0 0 0 1 0 0 0 1 ${part.file}`);
  return { templates, partCount, content: ['0 !LDRAW_ORG Model', ...colors, ...references, ...lines.slice(end)].join('\n') };
}

/** Bake reflections into geometry: InstancedMesh requires positive instance scales. */
function mirrorGeometry(source: THREE.BufferGeometry) {
  const geometry = source.clone().applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const count = geometry.index?.count ?? geometry.getAttribute('position').count;
  const indices = new Uint32Array(count);
  for (let index = 0; index < count; index += 3) {
    indices[index] = geometry.index?.getX(index) ?? index;
    indices[index + 1] = geometry.index?.getX(index + 2) ?? index + 2;
    indices[index + 2] = geometry.index?.getX(index + 1) ?? index + 1;
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

export function instantiateLDraw(plan: LDrawInstancePlan, prototypes: THREE.Group): THREE.Group {
  if (prototypes.children.length !== plan.templates.length) throw new Error('Some model parts could not be loaded.');
  const model = new THREE.Group();
  model.userData.instancedLDraw = true;
  model.userData.partCount = plan.partCount;
  prototypes.updateMatrixWorld(true);
  const reflection = new THREE.Matrix4().makeScale(-1, 1, 1);
  plan.templates.forEach((part, slot) => {
    prototypes.children[slot].traverse(object => {
      if (!(object instanceof THREE.Mesh)) return;
      // Keep brick surfaces and studs; skip separate edge-line draws on large builds.
      for (const mirrored of [false, true]) {
        const matrices = part.matrices.map(matrix => new THREE.Matrix4().multiplyMatrices(matrix, object.matrixWorld))
          .filter(matrix => (matrix.determinant() < 0) === mirrored);
        if (!matrices.length) continue;
        const mesh = new THREE.InstancedMesh(mirrored ? mirrorGeometry(object.geometry) : object.geometry, object.material, matrices.length);
        matrices.forEach((matrix, index) => mesh.setMatrixAt(index, mirrored ? matrix.multiply(reflection) : matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingBox();
        mesh.computeBoundingSphere();
        model.add(mesh);
      }
    });
  });
  if (!model.children.length) throw new Error('The model has no parts to show.');
  return model;
}

/** Shared geometries and materials must be freed only once when leaving a viewer. */
export function disposeLDrawScene(scene: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse(object => {
    if (object instanceof THREE.InstancedMesh) object.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
      geometries.add(object.geometry);
      (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}
