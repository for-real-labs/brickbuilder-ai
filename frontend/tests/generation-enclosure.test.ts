import * as RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, expect, it } from 'vitest';
import { addGenerationWalls, clampGrabPosition } from '../src/utils/generationEnclosure';
import { getBrickCollisionGroups } from '../src/utils/brickPhysics';
import { throwVelocity } from '../src/utils/generationDrag';
import { Vector3 } from 'three';

beforeAll(async () => { await RAPIER.init(); });
const table = { x: 0, z: 0, surface: 0, width: 500, depth: 500, height: 720 };
it.each([{ x: 1000, y: 0, z: 0 }, { x: -1000, y: 0, z: 0 }, { x: 0, y: 0, z: 1000 }, { x: 0, y: 0, z: -1000 }, { x: 0, y: 1000, z: 0 }])('contains a fast throw in direction %j', velocity => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    world.lengthUnit = 20;
    world.maxCcdSubsteps = 4;
    addGenerationWalls(world, table);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 200, 0).setCcdEnabled(true));
    const { partGroups } = getBrickCollisionGroups(true);
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 10, 10).setRestitution(0.5).setCollisionGroups(partGroups).setSolverGroups(partGroups), body);
    body.setLinvel(velocity, true);
    for (let frame = 0; frame < 60; frame++) {
      world.step();
      const position = body.translation();
      expect(Math.abs(position.x)).toBeLessThan(251);
      expect(Math.abs(position.z)).toBeLessThan(251);
      expect(position.y).toBeLessThan(720);
    }
    const finalVelocity = body.linvel();
    expect(finalVelocity.x * velocity.x + finalVelocity.y * velocity.y + finalVelocity.z * velocity.z).toBeLessThan(0);
  } finally { world.free(); }
});
it('clamps grabbed pieces inside the enclosure and caps throwing speed', () => {
  expect(clampGrabPosition({ x: 10000, y: 10000, z: -10000 }, table)).toEqual({ x: 185, y: 655, z: -185 });
  expect(throwVelocity(new Vector3(1000, 0, 0), 16, 0).length()).toBe(1000);
  expect(throwVelocity(new Vector3(10, 0, 0), 20, 121).length()).toBe(0);
  expect(throwVelocity(new Vector3(10, 0, 0), 20, 0).x).toBe(500);
});
