import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/** Desktop-only finishing; touch devices retain the same lighting and shadows. */
export function createDioramaEffects(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, extent: number) {
  const size = renderer.getSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(Math.min(renderer.getPixelRatio(), 1.5));
  const ao = new SSAOPass(scene, camera, size.x, size.y, 16);
  ao.kernelRadius = Math.min(12, extent * 0.035);
  ao.minDistance = 0.0001;
  ao.maxDistance = 0.008;
  const bloom = new UnrealBloomPass(size, 0.12, 0.5, 1.15);
  const output = new OutputPass();
  const render = new RenderPass(scene, camera);
  composer.addPass(render);
  composer.addPass(ao);
  composer.addPass(bloom);
  const vignette = new ShaderPass(VignetteShader);
  vignette.uniforms.offset.value = 0.8;
  composer.addPass(vignette);
  composer.addPass(output);
  composer.setSize(size.x, size.y);
  const overlayScene = new THREE.Scene();
  return {
    render() {
      const ruler = scene.getObjectByName('ruler-grid');
      if (!ruler?.visible) { composer.render(); return; }
      // Keep labels out of the depth/occlusion buffers and draw them crisply on top.
      const parent = ruler.parent!;
      const autoClear = renderer.autoClear;
      overlayScene.add(ruler);
      try {
        composer.render();
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(overlayScene, camera);
      } finally {
        parent.add(ruler);
        renderer.autoClear = autoClear;
      }
    },
    resize: (width: number, height: number) => composer.setSize(width, height),
    dispose() {
      render.dispose();
      ao.dispose();
      // Three r181 does not release these two SSAOPass allocations itself.
      ao.ssaoMaterial.dispose();
      ao.noiseTexture?.dispose();
      bloom.dispose();
      vignette.dispose();
      output.dispose();
      composer.dispose();
    },
  };
}
