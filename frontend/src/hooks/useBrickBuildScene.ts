import { useLayoutEffect, useRef, useState } from 'react';
import { BRICK_BUILD_SCENES } from '../components/brickBuildScenes';

// Counts matter once more than eleven loaders are active: releasing one
// duplicate must not make its animation available while another still plays.
const playing = new Map<number, number>();

export function useBrickBuildScene(active: boolean) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * BRICK_BUILD_SCENES.length));
  const preferred = useRef(index);

  useLayoutEffect(() => {
    if (!active) return;
    const available = BRICK_BUILD_SCENES.map((_, index) => index).filter(index => !playing.has(index));
    const selected = available.length && playing.has(preferred.current)
      ? available[Math.floor(Math.random() * available.length)] : preferred.current;
    playing.set(selected, (playing.get(selected) || 0) + 1);
    preferred.current = selected;
    setIndex(selected);

    return () => {
      const remaining = (playing.get(selected) || 1) - 1;
      if (remaining) playing.set(selected, remaining);
      else playing.delete(selected);
    };
  }, [active]);

  return BRICK_BUILD_SCENES[index];
}
