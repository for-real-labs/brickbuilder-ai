import React, { useEffect, useRef } from "react";

import { startFallingBricks } from '../utils/fallingBricks';

export default function FallingBricks({
  density = 22,
  zIndex = 0,
  opacity = 0.25,
  christmas = false,
}: {
  density?: number;   // total falling items; Christmas mode uses 70% bricks and 30% decorations
  zIndex?: number;    // stacking context
  opacity?: number;   // canvas global alpha
  christmas?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (ref.current) return startFallingBricks(ref.current, { density, christmas });
  }, [density, christmas]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
      style={{ zIndex, opacity }}
    >
      <canvas ref={ref} className="h-full w-full" />
    </div>
  );
}
