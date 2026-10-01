import { useLayoutEffect, useRef, useState } from 'react';
import { BRICK_BUILD_SCENES } from '../components/brickBuildScenes';

// Keep each model on screen for one full brick snap-in cycle.
export const BRICK_BUILD_CYCLE_MS = 6800;

export function useBrickBuildScene(active: boolean) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * BRICK_BUILD_SCENES.length));
  const current = useRef(index);
  const remaining = useRef(BRICK_BUILD_SCENES.map((_, sceneIndex) => sceneIndex).filter(sceneIndex => sceneIndex !== index));

  useLayoutEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (!remaining.current.length) {
        remaining.current = BRICK_BUILD_SCENES.map((_, sceneIndex) => sceneIndex);
      }
      // A new round includes every scene, but cannot start with the last one.
      const choices = remaining.current.filter(sceneIndex => sceneIndex !== current.current);
      const selected = choices[Math.floor(Math.random() * choices.length)];
      remaining.current = remaining.current.filter(sceneIndex => sceneIndex !== selected);
      current.current = selected;
      setIndex(selected);
    }, BRICK_BUILD_CYCLE_MS);

    return () => window.clearInterval(timer);
  }, [active]);

  return BRICK_BUILD_SCENES[index];
}
