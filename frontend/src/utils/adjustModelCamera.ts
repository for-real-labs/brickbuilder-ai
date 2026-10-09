import * as THREE from 'three';

/** Keyboard equivalent of the postcard viewer's orbit/zoom gestures. */
export function adjustModelCamera(camera: THREE.PerspectiveCamera, controls: {
  target: THREE.Vector3; minDistance: number; maxDistance: number; update: () => void;
}, key: string): boolean {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-'].includes(key)) return false;
  const offset = camera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  if (key === 'ArrowLeft') spherical.theta -= 0.1;
  if (key === 'ArrowRight') spherical.theta += 0.1;
  if (key === 'ArrowUp') spherical.phi -= 0.1;
  if (key === 'ArrowDown') spherical.phi += 0.1;
  if (key === '+' || key === '=') spherical.radius *= 0.9;
  if (key === '-') spherical.radius *= 1.1;
  spherical.makeSafe();
  spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(offset.setFromSpherical(spherical));
  controls.update();
  return true;
}
