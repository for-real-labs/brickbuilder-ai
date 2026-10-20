export const GENERATION_DROP_INTERVAL_MS = 3_000;
export const GENERATION_DROP_POOL_SIZE = 30;

/** Uses frame time so a background tab resumes with one drop, never a burst. */
export function createGenerationDropLoop(drop: (index: number) => void, count: number, reset: () => void = () => {}) {
  let nextDropMs = 0;
  let index = 0;
  return (nowMs: number) => {
    if (count === 0 || nowMs < nextDropMs) return;
    if (index === count) {
      reset();
      index = 0;
    }
    drop(index);
    index += 1;
    nextDropMs = nowMs + GENERATION_DROP_INTERVAL_MS;
  };
}
