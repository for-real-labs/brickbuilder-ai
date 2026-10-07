import React from 'react';
import { Clock3 } from 'lucide-react';

export function formatGenerationDuration(seconds: number): string {
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

export function GenerationDuration({ seconds, compact = false, className = 'mt-2 flex flex-wrap items-center gap-2 text-xs tabular-nums text-slate-500' }: {
  seconds?: number | null; compact?: boolean; className?: string;
}) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const duration = formatGenerationDuration(seconds);
  const label = `Generation time: ${duration}`;
  return <p className={className} aria-label={compact ? label : undefined} title={compact ? label : undefined}>
    <Clock3 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
    <span>{compact ? duration : label}</span>
  </p>;
}
