import * as RAPIER from '@dimforge/rapier3d-compat';
import { getBrickCollisionGroups } from './brickPhysics';

export interface TableEnclosure { x: number; z: number; surface: number; width: number; depth: number; height: number }

export function addGenerationWalls(world: RAPIER.World, table: TableEnclosure) {
  const { staticGroups } = getBrickCollisionGroups(true);
  const { x, z, surface, width, depth, height } = table;
  const thickness = 10;
  const boxes = [
    { x: x - width / 2 - thickness, y: surface + height / 2, z, hx: thickness, hy: height / 2, hz: depth / 2 + thickness * 2 },
    { x: x + width / 2 + thickness, y: surface + height / 2, z, hx: thickness, hy: height / 2, hz: depth / 2 + thickness * 2 },
    { x, y: surface + height / 2, z: z - depth / 2 - thickness, hx: width / 2, hy: height / 2, hz: thickness },
    { x, y: surface + height / 2, z: z + depth / 2 + thickness, hx: width / 2, hy: height / 2, hz: thickness },
    // A ceiling keeps upward throws inside the play area too.
    { x, y: surface + height + thickness, z, hx: width / 2 + thickness * 2, hy: thickness, hz: depth / 2 + thickness * 2 },
  ];
  for (const box of boxes) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(box.x, box.y, box.z));
    world.createCollider(RAPIER.ColliderDesc.cuboid(box.hx, box.hy, box.hz)
      .setFriction(0.55).setRestitution(0.45).setCollisionGroups(staticGroups).setSolverGroups(staticGroups), body);
  }
  return boxes;
}

export function clampGrabPosition(position: { x: number; y: number; z: number }, table: TableEnclosure) {
  const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
  const margin = 65;
  return {
    x: clamp(position.x, table.x - table.width / 2 + margin, table.x + table.width / 2 - margin),
    y: clamp(position.y, table.surface + margin, table.surface + table.height - margin),
    z: clamp(position.z, table.z - table.depth / 2 + margin, table.z + table.depth / 2 - margin),
  };
}
