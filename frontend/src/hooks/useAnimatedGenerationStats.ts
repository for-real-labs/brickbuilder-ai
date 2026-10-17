import { useEffect, useRef, useState } from 'react';
import type { GenerationStats } from '../services/getGenerationStatsApi';

const TICK_DURATION_MS = 1_000;
const COUNTERS = {
  generation_count: { maxBehind: 25, minPause: 1_800, maxPause: 5_200 },
  brick_count: { maxBehind: 25_000, minPause: 1_200, maxPause: 4_500 },
} as const;
type Counter = keyof GenerationStats;
const keys = Object.keys(COUNTERS) as Counter[];

/** Catch up to confirmed totals in independent, irregular, eased bursts. */
export function useAnimatedGenerationStats(target: GenerationStats | null): GenerationStats | null {
  const [displayed, setDisplayed] = useState<GenerationStats | null>(null);
  const current = useRef<GenerationStats | null>(null);

  useEffect(() => {
    if (!target) return;
    const frames: Partial<Record<Counter, number>> = {};
    const timers: Partial<Record<Counter, ReturnType<typeof setTimeout>>> = {};
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const publish = (value: GenerationStats) => {
      current.current = value;
      setDisplayed(value);
    };
    const publishCounter = (key: Counter, value: number) => {
      if (current.current) publish({ ...current.current, [key]: value });
    };
    const cancel = () => keys.forEach(key => {
      clearTimeout(timers[key]);
      if (frames[key] !== undefined) cancelAnimationFrame(frames[key]);
    });
    const schedule = (key: Counter) => {
      if (!current.current || current.current[key] >= target[key]) return;
      const { minPause, maxPause } = COUNTERS[key];
      timers[key] = setTimeout(() => {
        const from = current.current![key];
        const remaining = target[key] - from;
        const step = Math.max(1, Math.ceil(remaining * (0.12 + Math.random() * 0.18)));
        const to = Math.min(target[key], from + step);
        const startedAt = performance.now();
        const tick = (now: number) => {
          const progress = Math.min(1, Math.max(0, (now - startedAt) / TICK_DURATION_MS));
          const eased = 1 - Math.pow(1 - progress, 3);
          publishCounter(key, progress === 1 ? to : from + Math.floor((to - from) * eased));
          if (progress < 1) frames[key] = requestAnimationFrame(tick);
          else schedule(key);
        };
        frames[key] = requestAnimationFrame(tick);
      }, minPause + Math.random() * (maxPause - minPause));
    };
    const onMotionChange = () => {
      if (motionPreference?.matches) {
        cancel();
        publish(target);
      }
    };

    if (motionPreference?.matches) publish(target);
    else {
      // Begin at most 0.5% behind, with modest caps even for large totals.
      const behind = (key: Counter) => Math.max(0,
        target[key] - Math.min(COUNTERS[key].maxBehind, Math.ceil(target[key] * 0.005)));
      publish(current.current ? {
        generation_count: Math.min(current.current.generation_count, target.generation_count),
        brick_count: Math.min(current.current.brick_count, target.brick_count),
      } : {
        generation_count: behind('generation_count'),
        brick_count: behind('brick_count'),
      });
      keys.forEach(schedule);
    }
    motionPreference?.addEventListener('change', onMotionChange);
    return () => {
      cancel();
      motionPreference?.removeEventListener('change', onMotionChange);
    };
  }, [target?.generation_count, target?.brick_count]);

  return displayed;
}
