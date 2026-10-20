/** Explosions collide only with the room; the small generation pool also collides with itself. */
export function getBrickCollisionGroups(collideWithParts: boolean) {
  const room = 0x0001;
  const part = 0x0002;
  return {
    staticGroups: (room << 16) | part,
    partGroups: (part << 16) | room | (collideWithParts ? part : 0),
  };
}
