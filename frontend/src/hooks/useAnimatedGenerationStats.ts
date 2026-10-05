import { useEffect, useRef, useState } from 'react';
import type { GenerationStats } from '../services/getGenerationStatsApi';

const TICK_DURATION_MS = 1_000;

/** Animate both totals on one clock so even very different deltas finish together. */
export function useAnimatedGenerationStats(target: GenerationStats | null): GenerationStats | null {
  const [displayed, setDisplayed] = useState(target);
  const current = useRef(target);

  useEffect(() => {
    if (!target) return;
    const from = current.current;
    const publish = (value: GenerationStats) => {
      current.current = value;
      setDisplayed(value);
    };
    // Start with the real totals; corrections should also appear immediately.
    if (!from ||
      target.generation_count < from.generation_count || target.brick_count < from.brick_count) {
      publish(target);
      return;
    }
    if (target.generation_count === from.generation_count && target.brick_count === from.brick_count) return;
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motionPreference.matches) {
      publish(target);
      return;
    }

    let frame: number;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / TICK_DURATION_MS));
      const eased = 1 - Math.pow(1 - progress, 3);
      publish(progress === 1 ? target : {
        generation_count: from.generation_count + Math.floor((target.generation_count - from.generation_count) * eased),
        brick_count: from.brick_count + Math.floor((target.brick_count - from.brick_count) * eased),
      });
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    const onMotionChange = () => {
      if (motionPreference.matches) {
        cancelAnimationFrame(frame);
        publish(target);
      }
    };
    frame = requestAnimationFrame(tick);
    motionPreference.addEventListener('change', onMotionChange);
    return () => {
      cancelAnimationFrame(frame);
      motionPreference.removeEventListener('change', onMotionChange);
    };
  }, [target?.generation_count, target?.brick_count]);

  return displayed;
}
