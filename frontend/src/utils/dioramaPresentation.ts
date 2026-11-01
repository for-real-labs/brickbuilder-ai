import * as THREE from 'three';

export const DIORAMA_BACKGROUND = 0x788b80;

/** LDraw keeps hard brick edges while smoothing the curved surfaces of studs. */
export function prepareDioramaBricks(model: THREE.Object3D, softenEdges = true) {
  const replacements = new Map<THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial>();
  model.traverse(object => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
      const prepare = (material: THREE.Material) => {
        // Preserve chrome, rubber, metallic and already-physical finishes.
        if (!(material instanceof THREE.MeshStandardMaterial)
          || material instanceof THREE.MeshPhysicalMaterial
          || material.metalness !== 0 || material.roughness > 0.5) return material;
        let plastic = replacements.get(material);
        if (!plastic) {
          plastic = new THREE.MeshPhysicalMaterial();
          THREE.MeshStandardMaterial.prototype.copy.call(plastic, material);
          plastic.roughness = material.transparent ? 0.18 : 0.27;
          plastic.clearcoat = 0.32;
          plastic.clearcoatRoughness = 0.24;
          replacements.set(material, plastic);
        }
        return plastic;
      };
      object.material = Array.isArray(object.material) ? object.material.map(prepare) : prepare(object.material);
    } else if (softenEdges && object instanceof THREE.LineSegments) {
      // Retain faint brick seams, but remove the faceted conditional lines on studs.
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => {
        material.transparent = true;
        material.opacity = 0.12;
        material.depthWrite = false;
      });
      if (materials.some(material => 'isLDrawConditionalLineMaterial' in material)) object.visible = false;
    }
  });
  replacements.forEach((_, original) => original.dispose());
}

/** A sun/sky rig with shadow coverage fitted to each model, in LDraw units. */
export function createDioramaLighting(scene: THREE.Scene, shadowMapSize: number) {
  scene.environmentIntensity = 0.24;
  const key = new THREE.DirectionalLight(0xffdfab, 3.6);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  key.shadow.bias = -0.00015;
  key.shadow.radius = 10;
  key.shadow.blurSamples = 8;
  const fill = new THREE.HemisphereLight(0xc3def0, 0x57654c, 0.45);
  const rim = new THREE.DirectionalLight(0xc5dfff, 0.85);
  scene.add(key, key.target, fill, rim, rim.target);

  return {
    fit(bounds: THREE.Box3) {
      const center = bounds.getCenter(new THREE.Vector3());
      const extent = Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 1);
      key.position.copy(center).add(new THREE.Vector3(-1.5, 2, -0.8).multiplyScalar(extent));
      key.target.position.copy(center);
      rim.position.copy(center).add(new THREE.Vector3(1, 0.9, -1.6).multiplyScalar(extent));
      rim.target.position.copy(center);
      const camera = key.shadow.camera;
      camera.left = camera.bottom = -extent * 1.25;
      camera.right = camera.top = extent * 1.25;
      camera.near = extent * 0.05;
      camera.far = extent * 6;
      key.shadow.normalBias = extent * 0.001;
      camera.updateProjectionMatrix();
    },
    dispose() { key.shadow.dispose(); },
  };
}

/** Seamless ground; keep the table metadata used by the explode/rebuild physics. */
export function buildDioramaStage(scene: THREE.Scene, bounds: THREE.Box3, hasBaseplate: boolean) {
  const center = bounds.getCenter(new THREE.Vector3());
  const extent = Math.max(...bounds.getSize(new THREE.Vector3()).toArray(), 1);
  const surface = bounds.min.y - (hasBaseplate ? 4 : 0);
  const thickness = extent * 0.05;
  const width = extent * 6;
  const room = new THREE.Group();
  room.name = 'display-room';
  const table = new THREE.Group();
  table.name = 'display-table';
  Object.assign(table.userData, {
    hideBelowY: surface, tableTopSurface: surface, tableThickness: thickness,
    tableWidth: width, tableDepth: width, tableCenterX: center.x, tableCenterZ: center.z,
    floorY: surface - extent * 0.6, roomWidth: width, roomDepth: width,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 200, extent * 200),
    new THREE.MeshStandardMaterial({ color: 0x455e4f, roughness: 1, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, surface - extent * 0.002, center.z);
  ground.receiveShadow = true;
  table.add(ground);
  room.add(table);
  scene.add(room);
  scene.background = new THREE.Color(DIORAMA_BACKGROUND);
  scene.fog = new THREE.Fog(DIORAMA_BACKGROUND, extent * 3, extent * 12);
  return room;
}

/** Fit a miniature-like view to portrait as well as landscape containers. */
export function getDioramaViewDistance(camera: THREE.PerspectiveCamera, bounds: THREE.Box3) {
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 1);
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  // Hidden instruction panels can mount before they have a measurable width.
  const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
  return radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.12;
}

export function fitDioramaCamera(camera: THREE.PerspectiveCamera, bounds: THREE.Box3) {
  const center = bounds.getCenter(new THREE.Vector3());
  const distance = getDioramaViewDistance(camera, bounds);
  camera.position.copy(center).add(new THREE.Vector3(-1, 0.85, 1).normalize().multiplyScalar(distance));
  camera.lookAt(center);
  return distance;
}

/** Include the optional two-stud border when framing the viewer on narrow screens. */
export function getDioramaViewBounds(bounds: THREE.Box3, hasBaseplate: boolean) {
  const framed = bounds.clone();
  if (hasBaseplate) {
    framed.min.x = Math.floor((bounds.min.x - 40) / 20) * 20;
    framed.min.z = Math.floor((bounds.min.z - 40) / 20) * 20;
    framed.max.x = Math.ceil((bounds.max.x + 40) / 20) * 20;
    framed.max.z = Math.ceil((bounds.max.z + 40) / 20) * 20;
    framed.min.y -= 4;
  }
  return framed;
}

/** Keep the model clear at any zoom; haze belongs behind the subject. */
export function updateDioramaFog(scene: THREE.Scene, distance: number, extent: number) {
  if (!(scene.fog instanceof THREE.Fog)) return;
  scene.fog.near = distance + extent * 0.25;
  scene.fog.far = distance + extent * 8;
}
