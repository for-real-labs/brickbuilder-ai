import React, { useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';

export function GenerationElapsedTime({ startedAt }: { startedAt?: string | null }) {
  const [now, setNow] = useState(Date.now);
  // Older backend rows use naive UTC timestamps. Interpret those as UTC too.
  const start = startedAt ? Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(startedAt) ? startedAt : `${startedAt}Z`) : NaN;

  useEffect(() => {
    if (!Number.isFinite(start)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [start]);

  if (!Number.isFinite(start)) return null;
  const seconds = Math.max(0, Math.floor((now - start) / 1_000));
  const duration = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <p className="mt-2 flex items-center gap-2 text-xs tabular-nums text-slate-500">
    <Clock3 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
    <span>Building for {duration}</span>
  </p>;
}
