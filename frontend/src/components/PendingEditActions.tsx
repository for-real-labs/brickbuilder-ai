import React from 'react';
import posthog from 'posthog-js';
import { CancelGenerationButton } from './CancelGenerationButton';
import { GenerationElapsedTime } from './GenerationElapsedTime';

/** Actions while a new build or model edit runs in the background. */
export function PendingEditActions({ generationId, startedAt, onCancelled, onStartNew, isEdit = true }: {
  generationId: string | null;
  startedAt?: string;
  onCancelled: () => void;
  onStartNew: () => void;
  isEdit?: boolean;
}) {
  const buttonClass = 'min-h-11 min-w-0 rounded-full border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm';
  return <div className="mb-3 w-full" aria-label="Generation in progress actions">
    <GenerationElapsedTime startedAt={startedAt} />
    <p className="mb-3 text-sm leading-6 text-slate-700">
      You will receive an email when it's ready. You can safely leave this window
    </p>
    <div className="grid grid-cols-2 gap-2">
      {generationId ? <CancelGenerationButton generationId={generationId} onCancelled={onCancelled} isEdit={isEdit} compact />
        : <button type="button" className={buttonClass} disabled>Cancel</button>}
      <button type="button" className={buttonClass} disabled={!generationId} onClick={() => {
        posthog.capture(isEdit ? 'landing_edit_start_new_clicked' : 'landing_generation_start_new_clicked', { generation_id: generationId });
        onStartNew();
      }}>Start new</button>
    </div>
  </div>;
}
