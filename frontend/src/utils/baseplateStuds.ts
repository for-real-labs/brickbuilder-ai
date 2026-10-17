import * as THREE from 'three';

/** One draw call for the display baseplate, including city-sized models. */
export function createBaseplateStuds(minX: number, maxX: number, minZ: number, maxZ: number, floorY: number) {
  const columns = Math.ceil((maxX - minX) / 20);
  const rows = Math.ceil((maxZ - minZ) / 20);
  // Very wide models do not need an unlimited decorative stud grid.
  let stride = Math.max(1, Math.ceil(Math.sqrt(columns * rows / 50_000)));
  let count = Math.ceil(columns / stride) * Math.ceil(rows / stride);
  while (count > 50_000) {
    stride = Math.ceil(stride * count / 50_000);
    count = Math.ceil(columns / stride) * Math.ceil(rows / stride);
  }
  const geometry = new THREE.CylinderGeometry(6, 6, 4, 16);
  const material = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.7, metalness: 0.1 });
  const studs = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  let index = 0;
  for (let x = 0; x < columns; x += stride) {
    for (let z = 0; z < rows; z += stride) {
      studs.setMatrixAt(index++, matrix.makeTranslation(minX + x * 20 + 10, floorY + 2, minZ + z * 20 + 10));
    }
  }
  studs.instanceMatrix.needsUpdate = true;
  studs.castShadow = true;
  return studs;
}
