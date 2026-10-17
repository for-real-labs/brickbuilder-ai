import { useEffect, useRef, useState } from 'react';
import type { GenerationStats } from '../services/getGenerationStatsApi';

const TICK_DURATION_MS = 1_000;
const MIN_PAUSE_MS = 1_800;
const MAX_PAUSE_MS = 5_200;
const MAX_MODELS_BEHIND = 25;

/** Reveal each confirmed model, then count up its share of the added bricks. */
export function useAnimatedGenerationStats(target: GenerationStats | null): GenerationStats | null {
  const [displayed, setDisplayed] = useState<GenerationStats | null>(null);
  const current = useRef<GenerationStats | null>(null);
  const pendingBricks = useRef<number | null>(null);

  useEffect(() => {
    if (!target) return;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const publish = (value: GenerationStats) => {
      current.current = value;
      setDisplayed(value);
    };
    const cancel = () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
    const animateBricks = (to: number) => {
      const from = current.current!.brick_count;
      const startedAt = performance.now();
      pendingBricks.current = to;
      const tick = (now: number) => {
        const progress = Math.min(1, Math.max(0, (now - startedAt) / TICK_DURATION_MS));
        const eased = 1 - Math.pow(1 - progress, 3);
        publish({ ...current.current!, brick_count: progress === 1 ? to : from + Math.floor((to - from) * eased) });
        if (progress < 1) frame = requestAnimationFrame(tick);
        else {
          pendingBricks.current = null;
          schedule();
        }
      };
      frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      if (current.current!.generation_count >= target.generation_count) return;
      timer = setTimeout(() => {
        const from = current.current!;
        const modelsRemaining = target.generation_count - from.generation_count;
        const bricksAdded = Math.round((target.brick_count - from.brick_count) / modelsRemaining);
        publish({ ...from, generation_count: from.generation_count + 1 });
        animateBricks(from.brick_count + bricksAdded);
      }, MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS));
    };
    const onMotionChange = () => {
      if (motionPreference?.matches) {
        cancel();
        pendingBricks.current = null;
        publish(target);
      }
    };

    if (motionPreference?.matches) {
      pendingBricks.current = null;
      publish(target);
    } else {
      const modelsBehind = Math.min(MAX_MODELS_BEHIND, Math.ceil(target.generation_count * 0.005));
      publish(current.current ? {
        generation_count: Math.min(current.current.generation_count, target.generation_count),
        brick_count: Math.min(current.current.brick_count, target.brick_count),
      } : {
        generation_count: target.generation_count - modelsBehind,
        brick_count: target.generation_count > 0
          ? Math.round(target.brick_count * (target.generation_count - modelsBehind) / target.generation_count)
          : target.brick_count,
      });
      if (pendingBricks.current !== null) {
        // A refreshed total must not count the model for an unfinished burst twice.
        animateBricks(Math.min(pendingBricks.current, target.brick_count));
      } else if (current.current!.generation_count === target.generation_count) {
        publish(target);
      } else schedule();
    }
    motionPreference?.addEventListener('change', onMotionChange);
    return () => {
      cancel();
      motionPreference?.removeEventListener('change', onMotionChange);
    };
  }, [target?.generation_count, target?.brick_count]);

  return displayed;
}
