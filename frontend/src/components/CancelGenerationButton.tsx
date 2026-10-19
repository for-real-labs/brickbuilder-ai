import React, { useState } from 'react';
import { Loader2, Square } from 'lucide-react';
import posthog from 'posthog-js';
import { GetGenerationApiService } from '../services/getGenerationApi';

export function CancelGenerationButton({ generationId, onCancelled, isEdit = false, compact = false }: {
  generationId: string;
  onCancelled: () => void;
  isEdit?: boolean;
  compact?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    posthog.capture('generation_cancel_clicked', { generation_id: generationId, is_edit: isEdit });
    try {
      await GetGenerationApiService.cancelGeneration(generationId);
      posthog.capture('generation_cancelled', { generation_id: generationId, is_edit: isEdit });
      onCancelled();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to cancel. Please try again.');
      setPending(false);
    }
  };
  return <div className={compact ? 'min-w-0' : 'mt-3'}>
    <button type="button" disabled={pending} onClick={() => { void cancel(); }}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-slate-300 bg-white py-2 font-medium text-slate-600 transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-wait disabled:opacity-60 ${compact ? 'w-full min-w-0 px-2 text-xs sm:text-sm' : 'px-4 text-sm'}`}>
      {pending ? <Loader2 aria-hidden="true" size={13} className="animate-spin" /> : <Square aria-hidden="true" size={12} fill="currentColor" />}
      {pending ? (compact ? 'Stopping…' : 'Cancelling…') : compact ? 'Cancel' : isEdit ? 'Cancel edit' : 'Cancel generation'}
    </button>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
  </div>;
}
