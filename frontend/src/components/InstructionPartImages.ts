import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { LDrawLoader } from 'three/examples/jsm/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/examples/jsm/materials/LDrawConditionalLineMaterial.js';

interface Part {
  filename: string;
  colorCode: number;
}

export const instructionPartKey = ({ filename, colorCode }: Part) => `${colorCode}:${filename}`;
const identity = '0 0 0 1 0 0 0 1 0 0 0 1';
const previewFile = (index: number) => `__brickbuilder_thumbnail_${index}.ldr`;

export function buildInstructionThumbnailMpd(parts: Part[], header: string, definitions: string) {
  const files = new Map<string, string>();
  for (const [, filename] of definitions.matchAll(/^0 FILE (.+)$/gm)) {
    const path = filename.trim();
    files.set(path.toLowerCase(), path);
  }
  const placements: string[] = [];
  const previews: string[] = [];
  parts.forEach((part, index) => {
    const filename = part.filename.toLowerCase().replaceAll('\\', '/');
    const path = files.get(filename) ?? files.get(`parts/${filename}`) ?? files.get(`p/${filename}`) ?? files.get(`models/${filename}`);
    if (!path || !Number.isInteger(part.colorCode)) return;
    const preview = previewFile(index);
    placements.push(`1 ${part.colorCode} ${identity} ${preview}`);
    previews.push(`0 FILE ${preview}\n0 !LDRAW_ORG Model\n1 16 ${identity} ${path}`);
  });
  if (!previews.length) return '';
  const colors = header.split('\n').filter(line => /^0\s+!COLOUR\s/.test(line.trim()));
  return ['0 FILE __brickbuilder_thumbnails.ldr', ...colors, ...placements, ...previews, definitions].join('\n');
}

export function useInstructionPartImages(parts: Part[], header: string, definitions: string) {
  const [result, setResult] = useState<{ parts: Part[]; images: Map<string, string> } | null>(null);

  useEffect(() => {
    const content = buildInstructionThumbnailMpd(parts, header, definitions);
    if (!content) return;

    let cancelled = false;
    const loader = new LDrawLoader();
    loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
    void new Promise<THREE.Group>((resolve, reject) => loader.parse(content, resolve, reject)).then(group => {
      if (cancelled) return;
      let renderer: THREE.WebGLRenderer | undefined;
      try {
        // Render every row with one context, even when a step adds many part types.
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setSize(144, 112);
        const scene = new THREE.Scene();
        const light = new THREE.DirectionalLight(0xffffff, 2);
        light.position.set(-3, 5, 4);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x87949b, 2), light);
        const camera = new THREE.PerspectiveCamera(35, 144 / 112, 0.1, 10000);
        const direction = new THREE.Vector3(-2, 1.5, 2.4).normalize();
        const images = new Map<string, string>();
        const previews = new Map(group.children.map(child => [child.name, child]));

        parts.forEach((part, index) => {
          const preview = previews.get(previewFile(index));
          if (!preview) return;
          preview.rotation.x = Math.PI;
          scene.add(preview);
          const bounds = new THREE.Box3().setFromObject(preview);
          if (!bounds.isEmpty()) {
            const { center, radius } = bounds.getBoundingSphere(new THREE.Sphere());
            camera.position.copy(direction).multiplyScalar(Math.max(1, radius) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1).add(center);
            camera.lookAt(center);
            renderer!.render(scene, camera);
            images.set(instructionPartKey(part), renderer!.domElement.toDataURL());
          }
          group.add(preview);
        });
        setResult({ parts, images });
      } finally {
        renderer?.dispose();
        renderer?.forceContextLoss();
      }
    }).catch(() => { /* Keep the part details visible when a thumbnail cannot render. */ });

    return () => { cancelled = true; };
  }, [parts, header, definitions]);

  return result?.parts === parts ? result.images : undefined;
}
