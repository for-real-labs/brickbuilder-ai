import type * as THREE from 'three';

/** Capture a PNG without a backdrop, preserving the viewer's background state. */
export function captureTransparentPreview(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): string {
  const background = scene.background;
  const fog = scene.fog;
  const clearAlpha = renderer.getClearAlpha();

  try {
    scene.background = null;
    scene.fog = null;
    renderer.setClearAlpha(0);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png');
  } finally {
    scene.background = background;
    scene.fog = fog;
    renderer.setClearAlpha(clearAlpha);
  }
}
