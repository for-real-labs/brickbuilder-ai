import * as THREE from 'three';

export interface InstructionPart {
  filename: string;
  colorCode: number;
}

export interface InstructionPartHover extends InstructionPart {
  stepIndex: number;
  x: number;
  y: number;
}

export function normalizeInstructionPartFilename(filename: string) {
  return filename.toLowerCase().replaceAll('\\', '/').replace(/^(parts|p|models)\//, '');
}

export function createInstructionPartPicker(groups: THREE.Object3D[], firstCurrentPartIndex: number) {
  const meshes: THREE.Mesh[] = [];
  const parts = new Map<THREE.Object3D, InstructionPart>();
  for (const [index, group] of groups.entries()) {
    const colorCode = Number(group.userData.colorCode);
    if (!group.visible || !group.name || !Number.isInteger(colorCode)) continue;
    const part = { filename: group.name, colorCode };
    group.traverseVisible(object => {
      if (object instanceof THREE.Mesh && !object.userData.instructionOutline) {
        meshes.push(object);
        // Earlier pieces still occlude pieces added in this step.
        if (index >= firstCurrentPartIndex) parts.set(object, part);
      }
    });
  }

  const raycaster = new THREE.Raycaster();
  const point = new THREE.Vector2();
  const intersections: THREE.Intersection[] = [];
  return (camera: THREE.Camera, x: number, y: number) => {
    point.set(x, y);
    raycaster.setFromCamera(point, camera);
    raycaster.intersectObjects(meshes, false, intersections);
    const first = intersections[0];
    intersections.length = 0;
    return first ? parts.get(first.object) : undefined;
  };
}
