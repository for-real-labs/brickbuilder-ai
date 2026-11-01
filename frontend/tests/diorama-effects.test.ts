import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { createDioramaEffects } from '../src/utils/dioramaEffects';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('renders crisp rulers over scene effects and restores their parent (failure=%s)', fail => {
  const calls: string[] = [];
  let occlusion: SSAOPass | undefined;
  const passes = [RenderPass, SSAOPass, UnrealBloomPass, ShaderPass, OutputPass];
  const disposed = passes.map(pass => vi.spyOn(pass.prototype, 'dispose'));
  for (const pass of passes) {
    vi.spyOn(pass.prototype, 'render').mockImplementation(function (this: SSAOPass) {
      calls.push(pass.name);
      if (pass === SSAOPass) occlusion = this;
    });
  }
  const renderer = {
    autoClear: true,
    clearDepth: vi.fn(),
    render: vi.fn((overlay: THREE.Scene) => {
      expect(overlay.getObjectByName('ruler-grid')).toBe(ruler);
      if (fail) throw new Error('overlay failed');
    }),
    getSize: (target: THREE.Vector2) => target.set(800, 600),
    getPixelRatio: () => 2,
    getRenderTarget: () => null,
    setRenderTarget: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
  const scene = new THREE.Scene();
  const ruler = new THREE.Group();
  ruler.name = 'ruler-grid';
  scene.add(ruler);
  const camera = new THREE.PerspectiveCamera(35, 4 / 3, 1, 10000);
  const effects = createDioramaEffects(renderer, scene, camera, 200);
  if (fail) expect(() => effects.render()).toThrow('overlay failed');
  else effects.render();
  expect(ruler.parent).toBe(scene);
  expect(ruler.visible).toBe(true);
  expect(renderer.autoClear).toBe(true);
  expect(renderer.clearDepth).toHaveBeenCalledTimes(1);
  // Multiplying AO into an empty color buffer would produce a black canvas.
  expect(calls).toEqual(['RenderPass', 'SSAOPass', 'UnrealBloomPass', 'ShaderPass', 'OutputPass']);
  camera.aspect = 0.5;
  camera.updateProjectionMatrix();
  effects.resize(400, 800);
  expect(occlusion!.width).toBe(600); // cap expensive buffers at 1.5x on Retina displays
  expect(occlusion!.height).toBe(1200);
  expect(occlusion!.ssaoMaterial.uniforms.cameraProjectionMatrix.value.equals(camera.projectionMatrix)).toBe(true);
  effects.dispose();
  disposed.forEach(dispose => expect(dispose).toHaveBeenCalled());
});
