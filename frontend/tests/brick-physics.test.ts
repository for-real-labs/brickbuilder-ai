import * as RAPIER from '@dimforge/rapier3d-compat';
import { beforeAll, expect, it } from 'vitest';
import { getBrickCollisionGroups } from '../src/utils/brickPhysics';

beforeAll(async () => { await RAPIER.init(); });

it.each([true, false])('piece collisions are enabled only for generation: %s', collideWithParts => {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  try {
    const { staticGroups, partGroups } = getBrickCollisionGroups(collideWithParts);
    const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(10, 0.5, 10).setCollisionGroups(staticGroups).setSolverGroups(staticGroups), ground);
    const bodies = [1, 4].map(y => {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, y, 0));
      world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setCollisionGroups(partGroups).setSolverGroups(partGroups), body);
      return body;
    });
    for (let step = 0; step < 300; step++) world.step();
    const heights = bodies.map(body => body.translation().y).sort((a, b) => a - b);
    expect(heights[0]).toBeCloseTo(0.5, 1);
    expect(heights[1]).toBeCloseTo(collideWithParts ? 1.5 : 0.5, 1);
  } finally { world.free(); }
});
