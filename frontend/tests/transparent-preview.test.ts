import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { captureTransparentPreview } from '../src/utils/captureTransparentPreview';
import { captureCleanPreview } from '../src/components/ThreeLDRViewer';

function previewRenderer(onCapture: () => string) {
  let alpha = 1;
  const size = new THREE.Vector2(800, 400);
  return {
    getClearAlpha: () => alpha,
    setClearAlpha: (value: number) => { alpha = value; },
    getSize: (target: THREE.Vector2) => target.copy(size),
    setSize: (width: number, height: number) => { size.set(width, height); },
    render: vi.fn(),
    domElement: { toDataURL: vi.fn(onCapture) },
  } as unknown as THREE.WebGLRenderer;
}

describe('transparent model previews', () => {
  it('captures with no scene background and zero clear alpha, then restores both', () => {
    const scene = new THREE.Scene();
    const background = new THREE.Color(0xf5f0e8);
    scene.background = background;
    const camera = new THREE.PerspectiveCamera();
    const renderer = previewRenderer(() => {
      expect(scene.background).toBeNull();
      expect(renderer.getClearAlpha()).toBe(0);
      return 'data:image/png;base64,preview';
    });

    expect(captureTransparentPreview(renderer, scene, camera)).toBe('data:image/png;base64,preview');
    expect(renderer.domElement.toDataURL).toHaveBeenCalledWith('image/png');
    expect(renderer.render).toHaveBeenCalledWith(scene, camera);
    expect(scene.background).toBe(background);
    expect(renderer.getClearAlpha()).toBe(1);
  });

  it('restores the background and previous clear alpha when capture fails', () => {
    const scene = new THREE.Scene();
    const background = new THREE.Color('white');
    scene.background = background;
    const renderer = previewRenderer(() => { throw new Error('capture failed'); });
    renderer.setClearAlpha(0.5);

    expect(() => captureTransparentPreview(renderer, scene, new THREE.Camera())).toThrow('capture failed');
    expect(scene.background).toBe(background);
    expect(renderer.getClearAlpha()).toBe(0.5);
  });

  it.each([false, true])('hides the model surroundings and restores the viewer after capture (failure=%s)', (fail) => {
    const scene = new THREE.Scene();
    const background = new THREE.Color(0xf5f0e8);
    scene.background = background;
    const model = new THREE.Mesh(new THREE.BoxGeometry(40, 24, 20));
    model.name = 'ldraw-model';
    scene.add(model);
    const surroundings = ['display-room', 'baseplate', 'ruler-grid'].map(name => {
      const object = new THREE.Group();
      object.name = name;
      scene.add(object);
      return object;
    });
    surroundings[2].visible = false;
    const camera = new THREE.PerspectiveCamera(45, 2);
    camera.position.set(150, 200, 250);
    const originalPosition = camera.position.clone();
    const controls = { target: new THREE.Vector3(10, 20, 30), update: vi.fn() };
    const originalTarget = controls.target.clone();
    const renderer = previewRenderer(() => {
      expect(scene.background).toBeNull();
      expect(renderer.getClearAlpha()).toBe(0);
      expect(renderer.getSize(new THREE.Vector2())).toEqual(new THREE.Vector2(1024, 1024));
      expect(camera.aspect).toBe(1);
      expect(model.visible).toBe(true);
      expect(surroundings.every(object => !object.visible)).toBe(true);
      if (fail) throw new Error('capture failed');
      return 'data:image/png;base64,model';
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(captureCleanPreview(camera, controls, renderer, scene)).toBe(fail ? null : 'data:image/png;base64,model');
      expect(scene.background).toBe(background);
      expect(renderer.getClearAlpha()).toBe(1);
      expect(renderer.getSize(new THREE.Vector2())).toEqual(new THREE.Vector2(800, 400));
      expect(camera.aspect).toBe(2);
      expect(camera.position).toEqual(originalPosition);
      expect(controls.target).toEqual(originalTarget);
      expect(surroundings.map(object => object.visible)).toEqual([true, true, false]);
      expect(renderer.render).toHaveBeenLastCalledWith(scene, camera);
    } finally {
      warning.mockRestore();
      model.geometry.dispose();
    }
  });
});


it('captures the current postcard angle and framing without moving the camera', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1.4);
  camera.position.set(80, 20, 40);
  camera.lookAt(1, 2, 3);
  const orientation = camera.quaternion.clone();
  const renderer = previewRenderer(() => {
    expect(camera.position).toEqual(new THREE.Vector3(80, 20, 40));
    expect(camera.quaternion.equals(orientation)).toBe(true);
    expect(camera.aspect).toBe(1.4);
    expect(renderer.getSize(new THREE.Vector2())).toEqual(new THREE.Vector2(800, 400));
    return 'data:image/png;base64,chosen-angle';
  });
  expect(captureTransparentPreview(renderer, scene, camera)).toBe('data:image/png;base64,chosen-angle');
  expect(camera.position).toEqual(new THREE.Vector3(80, 20, 40));
  expect(camera.quaternion.equals(orientation)).toBe(true);
});
