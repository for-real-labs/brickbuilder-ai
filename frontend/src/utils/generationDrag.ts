import * as THREE from 'three';
import * as RAPIER from '@dimforge/rapier3d-compat';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clampGrabPosition, type TableEnclosure } from './generationEnclosure';

interface Grabbable { object: THREE.Object3D; body: RAPIER.RigidBody }
export function throwVelocity(delta: THREE.Vector3, elapsedMs: number, ageMs: number) {
  if (ageMs > 120 || elapsedMs <= 0) return new THREE.Vector3();
  return delta.clone().multiplyScalar(1000 / Math.max(elapsedMs, 16)).clampLength(0, 1000);
}

export function attachGenerationDrag(canvas: HTMLCanvasElement, camera: THREE.Camera, controls: OrbitControls,
  parts: Grabbable[], table: TableEnclosure, onThrow: (speed: number) => void) {
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const offset = new THREE.Vector3();
  const point = new THREE.Vector3();
  let grabbed: Grabbable | undefined;
  let pointerId: number | undefined;
  let previous = new THREE.Vector3();
  let velocity = new THREE.Vector3();
  let previousMs = 0;
  let resumeRotation = false;
  const originalTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  canvas.setAttribute('aria-label', 'Drag a brick and release to throw it');

  const aim = (event: PointerEvent) => {
    const bounds = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - bounds.left) / bounds.width * 2 - 1,
      -(event.clientY - bounds.top) / bounds.height * 2 + 1), camera);
  };
  const release = (throwPiece = false) => {
    if (!grabbed) return;
    const body = grabbed.body;
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const speed = throwPiece && performance.now() - previousMs <= 120 ? velocity : new THREE.Vector3();
    body.setLinvel(speed, true);
    if (throwPiece) onThrow(speed.length());
    grabbed = undefined;
    controls.autoRotate = resumeRotation;
    canvas.style.cursor = 'grab';
    const id = pointerId;
    pointerId = undefined;
    if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  };
  const down = (event: PointerEvent) => {
    if (grabbed || event.button !== 0) return;
    aim(event);
    const candidates = parts.filter(part => part.object.visible && part.body.isEnabled());
    const hit = raycaster.intersectObjects(candidates.map(part => part.object), true)
      .find(hit => (hit.object as THREE.Mesh).isMesh);
    if (!hit) return;
    grabbed = candidates.find(part => {
      let object: THREE.Object3D | null = hit.object;
      while (object) { if (object === part.object) return true; object = object.parent; }
      return false;
    });
    if (!grabbed) return;
    event.preventDefault();
    pointerId = event.pointerId;
    canvas.setPointerCapture(pointerId);
    resumeRotation = controls.autoRotate;
    controls.autoRotate = false;
    canvas.style.cursor = 'grabbing';
    previous.copy(grabbed.body.translation());
    offset.copy(previous).sub(hit.point);
    plane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), hit.point);
    grabbed.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    velocity.set(0, 0, 0);
    previousMs = performance.now();
  };
  const move = (event: PointerEvent) => {
    if (!grabbed || event.pointerId !== pointerId) return;
    event.preventDefault();
    aim(event);
    if (!raycaster.ray.intersectPlane(plane, point)) return;
    point.add(offset);
    point.copy(clampGrabPosition(point, table));
    const now = performance.now();
    velocity = throwVelocity(point.clone().sub(previous), now - previousMs, 0);
    grabbed.body.setNextKinematicTranslation(point);
    previous.copy(point);
    previousMs = now;
  };
  const up = (event: PointerEvent) => { if (event.pointerId === pointerId) release(true); };
  const cancel = () => release();
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel);
  window.addEventListener('blur', cancel);
  return {
    cancel,
    dispose: () => {
      cancel();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', cancel);
      canvas.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('blur', cancel);
      canvas.style.touchAction = originalTouchAction;
      canvas.style.cursor = '';
    },
  };
}
