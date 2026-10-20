import * as THREE from 'three';
import { gunzipSync, strFromU8 } from 'fflate';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { disposeLDrawScene } from './instancedLDraw';
import { GENERATION_DROP_POOL_SIZE } from './generationDrops';

export function decodePackedPart(bytes: Uint8Array) {
  // Some static hosts set Content-Encoding and the browser already decompresses the response.
  return strFromU8(bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
}

export interface CatalogPart { id: string; colors: number[]; name: string }
export function sampleCatalogParts(catalog: CatalogPart[], count: number, random = Math.random) {
  const pool = [...catalog];
  const result: { id: string; color: number }[] = [];
  while (pool.length && result.length < count) {
    const [part] = pool.splice(Math.floor(random() * pool.length), 1);
    result.push({ id: part.id, color: part.colors[Math.floor(random() * part.colors.length)] });
  }
  return result;
}

/** Fetch only one batch, with bounded parallelism; all geometry is served from our CDN. */
export async function loadGenerationCatalog(signal: AbortSignal): Promise<THREE.Group> {
  const response = await fetch('/assets/generation-parts/catalog.json', { signal });
  if (!response.ok) throw new Error('Could not load brick catalog');
  const choices = sampleCatalogParts(await response.json(), GENERATION_DROP_POOL_SIZE);
  const group = new THREE.Group();
  let next = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (next < choices.length) {
      const choice = choices[next++];
      try {
        const response = await fetch(`/assets/generation-parts/${choice.id}.mpd.gz`, { signal });
        if (!response.ok) continue;
        const source = decodePackedPart(new Uint8Array(await response.arrayBuffer()))
          .replace(/^1 16 /m, `1 ${choice.color} `);
        const loader = new LDrawLoader();
        loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
        const part = await new Promise<THREE.Group>((resolve, reject) => loader.parse(source, resolve, reject));
        if (signal.aborted) { disposeLDrawScene(part); break; }
        // Keep oversized catalog items (baseplates, panels, etc.) within the tabletop enclosure.
        const bounds = new THREE.Box3().setFromObject(part);
        const size = bounds.getSize(new THREE.Vector3());
        part.scale.setScalar(Math.min(1, 90 / Math.max(size.x, size.y, size.z, 1)));
        part.userData.catalogPartId = choice.id;
        part.visible = false;
        part.traverse(object => {
          if ((object as THREE.Mesh).isMesh) { object.castShadow = true; object.receiveShadow = true; }
        });
        group.add(part);
      } catch (error) {
        if (signal.aborted) break;
        // A failed asset must not prevent the remaining catalog choices from loading.
      }
    }
  });
  await Promise.all(workers);
  if (signal.aborted || !group.children.length) {
    disposeLDrawScene(group);
    throw new Error('Could not load generation pieces');
  }
  return group;
}
