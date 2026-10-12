import React, { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import * as THREE from 'three';
import { useLocation, useNavigate } from 'react-router-dom';
import { Upload, Loader2, Box } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GlbToBricksApiService } from '../services/glbToBricksApi';
import { GetGenerationApiService } from '../services/getGenerationApi';

/** Interactive GLB viewer built on raw three.js (OrbitControls + animation loop). */
function GlbViewer({ objectUrl }: { objectUrl: string }) {
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

        const loader = new GLTFLoader();
        loader.load(
          objectUrl,
          (gltf: { scene: THREE.Group }) => {
            if (disposed) return;
            const model = gltf.scene;
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
          },
          undefined,
          (err: unknown) => {
            if (disposed) return;
            console.error('Failed to load GLB:', err);
            setError('Failed to load GLB file');
            setLoading(false);
          },
        );

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
  }, [objectUrl]);

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

/** Settings card: upload a GLB, preview it, and convert. */
export function GlbUploadCard({ autoOpen = false }: { autoOpen?: boolean } = {}) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Revoke the object URL when it changes/unmounts.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  // Open the file browser automatically when requested (e.g. the parent's
  // "Upload glb" button was clicked).
  useEffect(() => {
    if (autoOpen) {
      posthog.capture('glb_upload_picker_opened', { page: window.location.pathname, input_type: 'glb', input_format: 'glb' });
      fileInputRef.current?.click();
    }
  }, [autoOpen]);

  const attribution = { page: pathname, input_type: 'glb', input_format: 'glb' };
  const openPicker = () => { posthog.capture('glb_upload_picker_opened', attribution); fileInputRef.current?.click(); };

  const handleSelectFile = (selected: File | null) => {
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith('.glb')) {
      setError('Please select a .glb file');
      return;
    }
    setError(null);
    setStatus(null);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    posthog.capture('glb_file_selected', attribution);
    setFile(selected);
    setObjectUrl(URL.createObjectURL(selected));
  };

  const handleConvert = async () => {
    if (!file || submitting) return;
    setSubmitting(true);
    setError(null);
    setStatus('Uploading…');
    posthog.capture('glb_upload_started', attribution);
    try {
      const { generation_id } = await GlbToBricksApiService.uploadGlb(
        file,
        'trimesh',
        40,
        session?.access_token,
      );
      posthog.capture('generation_started', { ...attribution, generation_id });
      setStatus('Processing…');
      await GetGenerationApiService.pollUntilComplete(generation_id, (res) => {
        if (res.status) setStatus(`Status: ${res.status}`);
      });
      posthog.capture('glb_conversion_completed', { ...attribution, generation_id });
      navigate(`/generated-model?id=${generation_id}`);
    } catch (err) {
      posthog.capture('glb_conversion_failed', attribution);
      console.error('GLB conversion failed:', err);
      setError(err instanceof Error ? err.message : 'Conversion failed');
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6 max-w-2xl mt-6">
      <h2 className="text-lg font-semibold text-slate-900 mb-1 flex items-center gap-2">
        <Box className="w-5 h-5 text-[#f44336]" />
        Upload GLB
      </h2>
      <p className="text-sm text-slate-500 mb-5">
        Upload a 3D model (.glb), preview it, and convert it into a brick model.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept=".glb"
        className="hidden"
        onChange={(e) => handleSelectFile(e.target.files?.[0] || null)}
      />

      {!objectUrl ? (
        <button
          type="button"
          onClick={openPicker}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer"
        >
          <Upload className="w-4 h-4" />
          Choose GLB file
        </button>
      ) : (
        <div className="space-y-4">
          <GlbViewer objectUrl={objectUrl} />

          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 truncate max-w-[60%]">{file?.name}</span>
            <button
              type="button"
              onClick={openPicker}
              disabled={submitting}
              className="text-sm font-medium text-[#f44336] hover:text-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50"
            >
              Change file
            </button>
          </div>

          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleConvert}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Box className="w-4 h-4" />}
              Convert to bricks
            </button>
            {status && <span className="text-sm text-slate-500">{status}</span>}
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </div>
  );
}

export default GlbUploadCard;
