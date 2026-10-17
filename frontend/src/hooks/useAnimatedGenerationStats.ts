import { useEffect, useRef, useState } from 'react';
import type { GenerationStats } from '../services/getGenerationStatsApi';

const TICK_DURATION_MS = 1_000;
const MIN_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = 5_000;
const MOCK_BATCH_SIZE = 100;

function createMockIncreases(totals: GenerationStats): GenerationStats[] {
  const averageBricks = totals.generation_count > 0
    ? totals.brick_count / totals.generation_count : 1_000;
  return Array.from({ length: MOCK_BATCH_SIZE }, () => ({
    generation_count: 1,
    brick_count: Math.max(1, Math.round(averageBricks * (0.5 + Math.random()))),
  }));
}

/** Start at real totals, then add paired simulated activity and incoming real increases. */
export function useAnimatedGenerationStats(target: GenerationStats | null): GenerationStats | null {
  const [displayed, setDisplayed] = useState<GenerationStats | null>(null);
  const latest = useRef(target);
  const ready = target !== null;

  useEffect(() => {
    latest.current = target;
  }, [target?.generation_count, target?.brick_count]);

  useEffect(() => {
    if (!ready || !latest.current) return;
    let real = { ...latest.current };
    const simulated = { generation_count: 0, brick_count: 0 };
    let current = { ...real };
    let destination = current;
    let increases = createMockIncreases(real);
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const motionPreference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const publish = (value: GenerationStats) => {
      current = value;
      setDisplayed(value);
    };
    const finishBurst = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      publish(destination);
    };
    const animateBricks = () => {
      const from = current.brick_count;
      const to = destination.brick_count;
      const startedAt = performance.now();
      // Both numbers visibly increase in the same render, even before the first frame.
      publish({ ...destination, brick_count: from + 1 });
      const tick = (now: number) => {
        const progress = Math.min(1, Math.max(0, (now - startedAt) / TICK_DURATION_MS));
        const eased = 1 - Math.pow(1 - progress, 3);
        publish({ ...destination, brick_count: from + Math.max(1, Math.floor((to - from) * eased)) });
        if (progress < 1) frame = requestAnimationFrame(tick);
        else frame = undefined;
      };
      frame = requestAnimationFrame(tick);
    };
    const schedule = () => {
      timer = setTimeout(() => {
        finishBurst();
        // Polls cannot reset the timer, interrupt a burst, or erase simulated activity.
        real = {
          generation_count: Math.max(real.generation_count, latest.current?.generation_count ?? 0),
          brick_count: Math.max(real.brick_count, latest.current?.brick_count ?? 0),
        };
        if (increases.length === 0) increases = createMockIncreases(real);
        const increase = increases.shift()!;
        simulated.generation_count += increase.generation_count;
        simulated.brick_count += increase.brick_count;
        destination = {
          generation_count: real.generation_count + simulated.generation_count,
          brick_count: real.brick_count + simulated.brick_count,
        };
        if (motionPreference?.matches) publish(destination);
        else animateBricks();
        schedule();
      }, MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS));
    };
    const onMotionChange = () => {
      if (motionPreference?.matches) finishBurst();
    };

    publish(current);
    schedule();
    motionPreference?.addEventListener('change', onMotionChange);
    return () => {
      clearTimeout(timer);
      if (frame !== undefined) cancelAnimationFrame(frame);
      motionPreference?.removeEventListener('change', onMotionChange);
    };
  }, [ready]);

  return displayed;
}
