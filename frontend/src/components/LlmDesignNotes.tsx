import React from 'react';
import { summarizeBuildProgress } from '../utils/buildProgress';
import { buildActivityIcon } from '../utils/buildActivityIcon';

export function LlmDesignNotes({ notes, summary, isThinking = false }: { notes: string; summary?: string; isThinking?: boolean }) {
  const activity = summary === undefined ? summarizeBuildProgress(notes) : summary.trim().split(/\s+/).slice(0, 8).join(' ');
  if ((!activity || (!notes.trim() && !summary)) && !isThinking) return null;
  const ActivityIcon = buildActivityIcon(activity);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 items-start gap-2.5 text-sm text-slate-500">
      <ActivityIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span className={`min-w-0 break-words ${isThinking ? 'build-thinking-shimmer' : ''}`}>
        {activity || 'Waiting for design output'}
      </span>
    </div>
  );
}
