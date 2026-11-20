import { Box3, BufferGeometry, Group, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { strToU8, zipSync } from 'fflate';
import { disposeLDrawScene } from './instancedLDraw';
import { downloadExport } from './modelExport';

export type ObjectExportFormat = 'obj' | 'glb' | 'stl' | 'stl-parts';

function safeFilename(name: string) {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100);
}

function createPartSTLArchive(model: Group, base: string) {
  const parts = new Map<Object3D, Mesh[]>();
  model.traverse(object => {
    if (!(object instanceof Mesh)) return;
    let part = object.parent ?? model;
    // The outermost Part owns its subparts and primitives. A submodel can place many Parts.
    for (let parent = object.parent; parent; parent = parent.parent) {
      if (parent.userData.type === 'Part' || parent.userData.type === 'Unofficial_Part') part = parent;
    }
    const meshes = parts.get(part);
    if (meshes) meshes.push(object);
    else parts.set(part, [object]);
  });
  if (!parts.size) throw new Error('No 3D geometry was found in this model.');

  const exporter = new STLExporter();
  const files: Record<string, Uint8Array> = {};
  let partNumber = 0;
  for (const [part, meshes] of parts) {
    const scene = new Group();
    const mirrored: BufferGeometry[] = [];
    try {
      for (const source of meshes) {
        let geometry = source.geometry;
        if (source.matrixWorld.determinant() < 0) {
          // STL derives normals from vertex order. Preserve winding after a reflection.
          const index = geometry.getIndex();
          const position = geometry.getAttribute('position');
          const reversed = [];
          for (let i = 0; i < (index?.count ?? position.count); i += 3) {
            if (index) reversed.push(index.getX(i), index.getX(i + 2), index.getX(i + 1));
            else reversed.push(i, i + 2, i + 1);
          }
          geometry = new BufferGeometry().setAttribute('position', position).setIndex(reversed);
          mirrored.push(geometry);
        }
        const mesh = new Mesh(geometry, source.material);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(source.matrixWorld);
        scene.add(mesh);
      }
      scene.rotation.x = -Math.PI / 2;
      scene.scale.setScalar(0.4);
      const bounds = new Box3().setFromObject(scene, true);
      const center = bounds.getCenter(new Vector3());
      scene.position.set(-center.x, -center.y, -bounds.min.z);
      scene.updateMatrixWorld(true);
      const data = exporter.parse(scene, { binary: true });
      const name = safeFilename(part.name.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') || 'part') || 'part';
      partNumber += 1;
      files[`${partNumber}_${name}.stl`] = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } finally {
      mirrored.forEach(geometry => geometry.dispose());
    }
  }
  return { blob: new Blob([zipSync(files)], { type: 'application/zip' }), filename: `${base}_parts.zip` };
}

/** Export the packed model itself, independent of viewer effects, steps and camera. */
export async function createObjectExport(content: string, name: string, format: ObjectExportFormat) {
  const base = safeFilename(name) || 'model';
  // LDrawLoader tolerates missing parts. Fail instead of silently exporting an incomplete model,
  // and never resolve arbitrary paths supplied by an imported model over the network.
  const normalize = (path: string) => path.trim().replaceAll('\\', '/').toLowerCase();
  const files = new Set([...content.matchAll(/^0\s+FILE\s+(.+)$/gim)].map(match => normalize(match[1])));
  for (const line of content.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] === '1' && !files.has(normalize(tokens.slice(14).join(' ')))) {
      throw new Error('This model is missing packed part geometry. Reopen the model and try again.');
    }
  }
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  const model = await new Promise<Group>((resolve, reject) => loader.parse(content, resolve, reject));
  const scene = new Group();
  try {
    model.updateMatrixWorld(true);
    if (format === 'stl-parts') return createPartSTLArchive(model, base);
    // Split material groups so OBJ's usemtl statements preserve every brick color.
    const materials = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    model.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const source = object.geometry;
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
      const groups = source.groups.length ? source.groups : [{ start: 0, count: source.index?.count ?? source.attributes.position.count, materialIndex: 0 }];
      for (const group of groups) {
        const original = sourceMaterials[group.materialIndex ?? 0] as MeshStandardMaterial;
        let material = materials.get(original);
        if (!material) {
          material = original.clone();
          material.name = `color_${materials.size}`;
          materials.set(original, material);
        }
        const geometry = source.clone();
        const count = Math.min(group.count, (source.index?.count ?? source.attributes.position.count) - group.start);
        const indices = Array.from({ length: count }, (_, i) => source.index ? source.index.getX(group.start + i) : group.start + i);
        geometry.setIndex(indices);
        geometry.clearGroups();
        geometry.applyMatrix4(object.matrixWorld);
        const mesh = new Mesh(geometry, material);
        mesh.name = `mesh_${scene.children.length}`;
        scene.add(mesh);
      }
    });
    if (!scene.children.length) throw new Error('No 3D geometry was found in this model.');
    // LDraw is Y-down, 0.4 mm/LDU. glTF uses meters/Y-up; slicers use mm/Z-up.
    scene.rotation.x = format === 'stl' ? -Math.PI / 2 : Math.PI;
    scene.scale.setScalar(format === 'glb' ? 0.0004 : 0.4);
    scene.updateMatrixWorld(true);
    if (format === 'stl') {
      const bounds = new Box3().setFromObject(scene);
      const center = bounds.getCenter(new Vector3());
      scene.position.set(-center.x, -center.y, -bounds.min.z);
      scene.updateMatrixWorld(true);
      const data = new STLExporter().parse(scene, { binary: true });
      return { blob: new Blob([data], { type: 'model/stl' }), filename: `${base}.stl` };
    }
    if (format === 'glb') {
      const data = await new GLTFExporter().parseAsync(scene, { binary: true });
      return { blob: new Blob([data as ArrayBuffer], { type: 'model/gltf-binary' }), filename: `${base}.glb` };
    }
    const mtl = [...materials.values()].map(material => {
      const color = material.color.clone().convertLinearToSRGB();
      return `newmtl ${material.name}\nKd ${color.r} ${color.g} ${color.b}\nd ${material.opacity}\n`;
    }).join('\n');
    const obj = `# Units: millimeters\nmtllib ${base}.mtl\n${new OBJExporter().parse(scene)}`;
    const zip = zipSync({ [`${base}.obj`]: strToU8(obj), [`${base}.mtl`]: strToU8(mtl) });
    return { blob: new Blob([zip], { type: 'application/zip' }), filename: `${base}_obj.zip` };
  } finally {
    disposeLDrawScene(scene);
    disposeLDrawScene(model);
  }
}

export async function downloadObject(content: string, name: string, format: ObjectExportFormat) {
  const { blob, filename } = await createObjectExport(content, name, format);
  downloadExport(blob, filename);
}
