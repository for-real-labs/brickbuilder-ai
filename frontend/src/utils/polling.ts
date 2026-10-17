/** One request at a time, with visibility-aware scheduling and bounded retries. */
export function startPolling(
  task: (signal: AbortSignal) => Promise<number | void>,
  { intervalMs, allowBackground = () => false }: { intervalMs: number; allowBackground?: () => boolean },
) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  let failures = 0;
  const canRun = () => document.visibilityState !== 'hidden' || allowBackground();
  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped && canRun()) timer = setTimeout(run, delay);
  };
  const run = async () => {
    if (stopped || running || !canRun()) return;
    clearTimeout(timer);
    running = true;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let next = intervalMs;
    try {
      next = (await task(controller.signal)) ?? intervalMs;
      failures = 0;
    } catch {
      failures += 1;
      next = Math.min(60_000, intervalMs * 2 ** Math.min(failures, 4));
    } finally {
      clearTimeout(timeout);
      running = false;
      request = undefined;
      schedule(next);
    }
  };
  const refresh = () => { if (!stopped) void run(); };
  const onVisibility = () => {
    if (canRun()) refresh();
    else {
      clearTimeout(timer);
      request?.abort();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', refresh);
  refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      request?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', refresh);
    },
  };
}
