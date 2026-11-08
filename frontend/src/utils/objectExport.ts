import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { strToU8, zipSync } from 'fflate';
import { disposeLDrawScene } from './instancedLDraw';
import { downloadExport } from './modelExport';

export type ObjectExportFormat = 'obj' | 'glb' | 'stl';

/** Export the packed model itself, independent of viewer effects, steps and camera. */
export async function createObjectExport(content: string, name: string, format: ObjectExportFormat) {
  const base = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'model';
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
