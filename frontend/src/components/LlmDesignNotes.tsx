import React from 'react';
import { Blocks } from 'lucide-react';
import { summarizeBuildProgress } from '../utils/buildProgress';

export function LlmDesignNotes({ notes, isThinking = false }: { notes: string; isThinking?: boolean }) {
  if (!notes.trim() && !isThinking) return null;
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="flex min-w-0 items-start gap-2.5 text-sm text-slate-500">
      <Blocks aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <span className={`min-w-0 break-words ${isThinking ? 'build-thinking-shimmer' : ''}`}>
        {summarizeBuildProgress(notes)}
      </span>
    </div>
  );
}
