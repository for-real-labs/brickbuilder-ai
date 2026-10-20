import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { attachGenerationDrag } from '../src/utils/generationDrag';

beforeAll(async () => { await RAPIER.init(); });
afterEach(() => vi.restoreAllMocks());
it('grabs, moves and throws a piece while pausing rotation, then cleans up pointer handlers', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200 } as DOMRect);
  canvas.setPointerCapture = vi.fn();
  canvas.hasPointerCapture = () => true;
  canvas.releasePointerCapture = vi.fn();
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 2000);
  camera.position.set(0, 100, 500);
  camera.lookAt(0, 100, 0);
  camera.updateMatrixWorld();
  const object = new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30), new THREE.MeshBasicMaterial());
  object.position.set(0, 100, 0);
  object.updateMatrixWorld();
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 100, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(15, 15, 15), body);
  const controls = { autoRotate: true } as OrbitControls;
  const thrown = vi.fn();
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const drag = attachGenerationDrag(canvas, camera, controls, [{ object, body }],
    { x: 0, z: 0, width: 500, depth: 500, surface: 0, height: 720 }, thrown);
  const send = (type: string, x = 100) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: 100 });
    canvas.dispatchEvent(event);
  };
  try {
    send('pointerdown');
    expect(body.isKinematic()).toBe(true);
    expect(controls.autoRotate).toBe(false);
    now = 120;
    send('pointermove', 130);
    world.step();
    expect(body.translation().x).toBeGreaterThan(0);
    send('pointerup', 130);
    expect(body.isDynamic()).toBe(true);
    expect(body.linvel().x).toBeGreaterThan(0);
    expect(controls.autoRotate).toBe(true);
    expect(thrown).toHaveBeenCalledOnce();
    send('pointerdown');
    drag.cancel();
    expect(body.isDynamic()).toBe(true);
    expect(controls.autoRotate).toBe(true);
    drag.dispose();
    send('pointerdown');
    expect(body.isDynamic()).toBe(true);
  } finally {
    drag.dispose();
    object.geometry.dispose();
    object.material.dispose();
    world.free();
  }
});
