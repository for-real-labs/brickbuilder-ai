import * as THREE from 'three';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { describe, expect, it, vi } from 'vitest';
import { buildDioramaStage, createDioramaLighting, fitDioramaCamera, getDioramaViewBounds, updateDioramaFog, prepareDioramaBricks } from '../src/utils/dioramaPresentation';

describe('diorama presentation', () => {
  it('lights shared and instanced plastic without changing brick colors, opacity or special finishes', () => {
    const model = new THREE.Group();
    const plastic = new THREE.MeshStandardMaterial({ color: 0xc91a09, roughness: 0.3 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1250aa, roughness: 0.3, transparent: true, opacity: 0.4 });
    const chrome = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0 });
    const rubber = new THREE.MeshStandardMaterial({ roughness: 0.9 });
    const dispose = vi.spyOn(plastic, 'dispose');
    const solid = new THREE.Mesh(new THREE.BoxGeometry(), plastic);
    const repeated = new THREE.InstancedMesh(solid.geometry, plastic, 3);
    const mixed = new THREE.Mesh(solid.geometry, [plastic, glass, chrome, rubber]);
    const edge = new THREE.LineSegments(new THREE.BufferGeometry(), new LDrawConditionalLineMaterial());
    model.add(solid, repeated, mixed, edge);
    prepareDioramaBricks(model);
    expect(solid.material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(solid.material).toBe(repeated.material);
    expect(mixed.material[0]).toBe(solid.material);
    expect(solid.material.color.getHex()).toBe(0xc91a09);
    expect(mixed.material[1].opacity).toBe(0.4);
    expect(mixed.material[1].transparent).toBe(true);
    expect(mixed.material.slice(2)).toEqual([chrome, rubber]);
    expect([solid, repeated, mixed].every(mesh => mesh.castShadow && mesh.receiveShadow)).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(edge.visible).toBe(false);
    const upgraded = solid.material;
    prepareDioramaBricks(model);
    expect(solid.material).toBe(upgraded);
  });

  it('retains explicit edge lines when requested', () => {
    const model = new THREE.Group();
    const edge = new THREE.LineSegments();
    model.add(edge);
    prepareDioramaBricks(model, false);
    expect(edge.visible).toBe(true);
  });

  it.each([false, true])('keeps the ground and explode collision surface aligned (baseplate=%s)', baseplate => {
    const scene = new THREE.Scene();
    const bounds = new THREE.Box3(new THREE.Vector3(100, -40, 300), new THREE.Vector3(300, 80, 440));
    buildDioramaStage(scene, bounds, baseplate);
    const table = scene.getObjectByName('display-table')!;
    const surface = -40 - (baseplate ? 4 : 0);
    expect(table.userData.tableTopSurface).toBe(surface);
    expect(table.userData.hideBelowY).toBe(surface);
    expect(table.userData.tableCenterX).toBe(200);
    expect(table.userData.tableCenterZ).toBe(370);
    expect(table.userData.tableWidth).toBeGreaterThan(200);
    expect(table.children[0].position.y).toBeCloseTo(surface, 0);
    expect(scene.fog).toBeInstanceOf(THREE.Fog);
  });

  it('fits the light to translated models at small and very large scales', () => {
    const scene = new THREE.Scene();
    const lighting = createDioramaLighting(scene, 1024);
    const light = scene.children.find(object => object instanceof THREE.DirectionalLight && object.castShadow) as THREE.DirectionalLight;
    for (const scale of [0.1, 1, 100]) {
      const bounds = new THREE.Box3(new THREE.Vector3(200, -100, 30), new THREE.Vector3(200 + 80 * scale, -100 + 40 * scale, 30 + 50 * scale));
      lighting.fit(bounds);
      scene.updateMatrixWorld(true);
      light.shadow.updateMatrices(light);
      const frustum = light.shadow.getFrustum();
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        expect(frustum.containsPoint(new THREE.Vector3(x, y, z))).toBe(true);
      }
    }
    lighting.dispose();
  });

  it.each([0.45, 1, 2])('frames every model corner at aspect ratio %s', aspect => {
    const camera = new THREE.PerspectiveCamera(35, aspect, 1, 10000);
    const bounds = getDioramaViewBounds(new THREE.Box3(new THREE.Vector3(-170, -10, -60), new THREE.Vector3(130, 120, 80)), true);
    fitDioramaCamera(camera, bounds);
    camera.updateMatrixWorld();
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1);
      expect(Math.abs(projected.y)).toBeLessThan(1);
    }
  });
});

it('keeps haze behind the model when zooming out on phones', () => {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x788b80, 1, 100);
  for (const distance of [200, 1000, 10000]) {
    updateDioramaFog(scene, distance, 100);
    expect(scene.fog.near).toBeGreaterThan(distance);
    expect(scene.fog.far - scene.fog.near).toBe(775);
  }
});

it('adds only the baseplate border to the framing bounds without mutating the model bounds', () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-31, -20, 15), new THREE.Vector3(31, 40, 50));
  expect(getDioramaViewBounds(bounds, false).equals(bounds)).toBe(true);
  const framed = getDioramaViewBounds(bounds, true);
  expect(framed.min.toArray()).toEqual([-80, -24, -40]);
  expect(framed.max.toArray()).toEqual([80, 40, 100]);
  expect(bounds.min.y).toBe(-20);
});

it('keeps hidden instruction panels finite until their first resize', () => {
  const camera = new THREE.PerspectiveCamera(35, 0);
  const bounds = new THREE.Box3(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 100, 50));
  fitDioramaCamera(camera, bounds);
  expect(camera.position.toArray().every(Number.isFinite)).toBe(true);
});
