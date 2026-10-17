import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Loader2 } from 'lucide-react';
import type { MeshFormat } from '../voxelConverters';

/** Interactive GLB viewer built on raw three.js (OrbitControls + animation loop). */
export function ModelMeshPreview({ objectUrl, format = 'glb' }: { objectUrl: string; format?: MeshFormat }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let renderer: THREE.WebGLRenderer | null = null;
    let animationId = 0;
    let resizeObserver: ResizeObserver | null = null;
    // Holds the controls instance for cleanup
    let controls: { dispose: () => void; update: () => void } | null = null;

    const container = containerRef.current;
    if (!container) return;

    const setup = async () => {
      try {
        setLoading(true);
        setError(null);

        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
        if (disposed || !container) return;

        const width = container.clientWidth || 400;
        const height = container.clientHeight || 320;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xeef2f5);

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1000);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(width, height);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        container.appendChild(renderer.domElement);

        const pmrem = new THREE.PMREMGenerator(renderer);
        scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

        const orbit = new OrbitControls(camera, renderer.domElement);
        orbit.enableDamping = true;
        controls = orbit;

        const onLoad = (model: THREE.Group) => {
            if (disposed) return;
            scene.add(model);

            // Frame the model.
            const bbox = new THREE.Box3().setFromObject(model);
            const size = bbox.getSize(new THREE.Vector3());
            const center = bbox.getCenter(new THREE.Vector3());
            const radius = Math.max(size.x, size.y, size.z) * 0.5 || 1;

            orbit.target.copy(center);
            camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).multiplyScalar(radius * 2.4));
            camera.near = radius / 100;
            camera.far = radius * 100;
            camera.updateProjectionMatrix();
            orbit.update();

            setLoading(false);
        };
        const onError = () => {
          if (disposed) return;
          setError(`Failed to load ${format.toUpperCase()} file`);
          setLoading(false);
        };
        if (format === 'obj') {
          const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
          if (disposed) return;
          new OBJLoader().load(objectUrl, onLoad, undefined, onError);
        } else {
          new GLTFLoader().load(objectUrl, gltf => onLoad(gltf.scene), undefined, onError);
        }

        const animate = () => {
          animationId = requestAnimationFrame(animate);
          orbit.update();
          renderer!.render(scene, camera);
        };
        animate();

        resizeObserver = new ResizeObserver(() => {
          if (!renderer || !container) return;
          const w = container.clientWidth;
          const h = container.clientHeight;
          if (w === 0 || h === 0) return;
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        });
        resizeObserver.observe(container);
      } catch (err) {
        console.error('GLB viewer setup failed:', err);
        setError('Failed to initialize 3D viewer');
        setLoading(false);
      }
    };

    setup();

    return () => {
      disposed = true;
      if (animationId) cancelAnimationFrame(animationId);
      if (resizeObserver) resizeObserver.disconnect();
      if (controls) controls.dispose();
      if (renderer) {
        renderer.dispose();
        renderer.forceContextLoss();
        if (renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      }
    };
  }, [objectUrl, format]);

  return (
    <div className="relative w-full h-72 rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
      <div ref={containerRef} className="absolute inset-0" />
      {loading && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading model…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-red-500 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}
