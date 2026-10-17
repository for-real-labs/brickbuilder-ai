import * as THREE from 'three';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { describe, expect, it, vi } from 'vitest';
import { disposeLDrawScene, instantiateLDraw, planLDrawInstances } from '../src/utils/instancedLDraw';
import { createBaseplateStuds } from '../src/utils/baseplateStuds';
import { configureModelViewRange } from '../src/utils/adjustModelCamera';

const placement = (x: number, color = '4', mirrored = false) => `1 ${color} ${x} 0 0 ${mirrored ? '-1' : '1'} 0 0 0 1 0 0 0 1 brick.dat`;
const library = '\n0 FILE brick.dat\n0 !LDRAW_ORG Part\n3 16 0 0 0 20 0 0 0 24 0\n2 24 0 0 0 20 0 0\n';
const content = (count: number) => '0 FILE city.ldr\n0 !COLOUR Red CODE 4 VALUE #C91A09 EDGE #333333\n'
  + Array.from({ length: count }, (_, i) => placement(i * 20)).join('\n') + library;
const parse = async (text: string) => {
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  loader.addDefaultMaterials();
  loader.smoothNormals = false;
  return new Promise<THREE.Group>((resolve, reject) => loader.parse(text, resolve, reject));
};

describe('large LDraw models', () => {
  it('loads 15,662 placements from one prototype, retaining their positions and colors', async () => {
    const plan = planLDrawInstances(content(15662))!;
    expect(plan.partCount).toBe(15662);
    expect(plan.templates).toHaveLength(1);
    expect(plan.content).toContain(library);
    const prototype = await parse(plan.content);
    const model = instantiateLDraw(plan, prototype);
    expect(model.children).toHaveLength(1);
    const mesh = model.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(15662);
    expect(mesh.geometry).toBe((prototype.children[0].children.find(child => child instanceof THREE.Mesh) as THREE.Mesh).geometry);
    const matrix = new THREE.Matrix4();
    mesh.getMatrixAt(15661, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).x).toBe(313220);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    expect((materials[0] as THREE.MeshStandardMaterial).color.getHexString()).toBe('c91a09');
    expect(new THREE.Box3().setFromObject(model).max.x).toBe(313240);
    disposeLDrawScene(model);
  });

  it('handles anonymous MPD roots and keeps different brick colors in separate batches', async () => {
    const source = content(1000).replace('0 FILE city.ldr\n', '')
      .replace(placement(0), placement(0, '0x20000FF'));
    const plan = planLDrawInstances(source)!;
    expect(plan.templates).toHaveLength(2);
    const model = instantiateLDraw(plan, await parse(plan.content));
    expect(model.children.map(child => (child as THREE.InstancedMesh).count)).toEqual([1, 999]);
    expect(plan.content.match(/^0 FILE brick.dat/gm)).toHaveLength(1);
    disposeLDrawScene(model);
  });

  it('preserves rotations and mirrored geometry without negative instance scales', async () => {
    const source = content(1000).replace(placement(0), placement(0, '4', true))
      .replace(placement(20), '1 4 20 40 60 0 0 1 0 1 0 -1 0 0 brick.dat');
    const plan = planLDrawInstances(source)!;
    const model = instantiateLDraw(plan, await parse(plan.content));
    const regular = model.children.find(child => (child as THREE.InstancedMesh).count === 999) as THREE.InstancedMesh;
    const mirrored = model.children.find(child => (child as THREE.InstancedMesh).count === 1) as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    regular.getMatrixAt(0, matrix);
    expect(new THREE.Vector3(20, 0, 0).applyMatrix4(matrix)).toEqual(new THREE.Vector3(20, 40, 40));
    mirrored.getMatrixAt(0, matrix);
    expect(matrix.determinant()).toBeGreaterThan(0);
    expect(new THREE.Box3().setFromObject(mirrored).min.x).toBe(-20);
    const index = mirrored.geometry.index!;
    expect([index.getX(0), index.getX(1), index.getX(2)]).toEqual([0, 2, 1]);
    disposeLDrawScene(model);
  });

  it('retains BFC inversion and does not include embedded library references as placements', () => {
    const source = content(1000).replace(placement(0), '0 BFC INVERTNEXT\n' + placement(0));
    const plan = planLDrawInstances(source)!;
    expect(plan.templates).toHaveLength(2);
    expect(plan.templates[0].inverted).toBe(true);
    expect(plan.templates[1].inverted).toBe(false);
    expect(plan.partCount).toBe(1000);
  });

  it('keeps small, hierarchical, inline-face, and invalid models on their existing loader path', () => {
    expect(planLDrawInstances(content(999))).toBeNull();
    expect(planLDrawInstances(content(1000).replace('brick.dat', 'house.ldr'))).toBeNull();
    expect(planLDrawInstances('3 4 0 0 0 20 0 0 0 20 0\n' + content(1000))).toBeNull();
    expect(planLDrawInstances(content(1000).replace(placement(0), placement(NaN)))).toBeNull();
  });

  it('reports missing parts without rendering an incomplete city', async () => {
    const plan = planLDrawInstances(content(1000))!;
    expect(() => instantiateLDraw(plan, new THREE.Group())).toThrow('Some model parts could not be loaded');
    const empty = new THREE.Group(); empty.add(new THREE.Group());
    expect(() => instantiateLDraw(plan, empty)).toThrow('no parts to show');
  });

  it('frees shared GPU resources once and releases every instance buffer', () => {
    const scene = new THREE.Group();
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const meshes = [new THREE.InstancedMesh(geometry, material, 10), new THREE.InstancedMesh(geometry, material, 20)];
    scene.add(...meshes);
    const disposeGeometry = vi.spyOn(geometry, 'dispose');
    const disposeMaterial = vi.spyOn(material, 'dispose');
    const disposeInstances = meshes.map(mesh => vi.spyOn(mesh, 'dispose'));
    disposeLDrawScene(scene);
    expect(disposeGeometry).toHaveBeenCalledOnce();
    expect(disposeMaterial).toHaveBeenCalledOnce();
    disposeInstances.forEach(dispose => expect(dispose).toHaveBeenCalledOnce());
  });
});

describe('large display baseplates', () => {
  it('draws the stud grid in one batch at the original spacing and height', () => {
    const studs = createBaseplateStuds(-20, 40, 0, 40, -10);
    expect(studs.count).toBe(6);
    const matrix = new THREE.Matrix4(); studs.getMatrixAt(5, matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix)).toEqual(new THREE.Vector3(30, -8, 30));
    disposeLDrawScene(studs);
  });
  it.each([[20000, 20000], [20000000, 20]])('caps decorative studs on unusually wide models (%s × %s)', (width, depth) => {
    const studs = createBaseplateStuds(0, width, 0, depth, 0);
    expect(studs.count).toBeLessThanOrEqual(50000);
    disposeLDrawScene(studs);
  });
  it('keeps a city visible at the farthest supported zoom', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
    const controls = { maxDistance: Infinity };
    configureModelViewRange(camera, controls, 3200);
    expect(camera.far).toBeGreaterThan(controls.maxDistance + 3200);
    const point = new THREE.Vector3(0, 0, -(controls.maxDistance + 1600)).project(camera);
    expect(point.z).toBeLessThan(1);
    expect(point.z).toBeGreaterThan(-1);
  });
});
