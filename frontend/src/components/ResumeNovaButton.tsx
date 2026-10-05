import React, { useState } from 'react';
import { NovaToBricksApiService } from '../services/novaToBricksApi';

export function ResumeNovaButton({ generationId, onResumed }: {
  generationId: string;
  onResumed: (generationId: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await NovaToBricksApiService.edit(generationId,
        'Continue this build from the saved conversation and workspace, and publish the completed model. Reuse your existing research and files.');
      onResumed(result.generation_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to resume. Please try again.');
      setPending(false);
    }
  };
  return <div className="mt-3">
    <button type="button" disabled={pending} onClick={() => { void resume(); }}
      className="min-h-11 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60">
      {pending ? 'Resuming…' : 'Resume build'}
    </button>
    <p className="mt-1 text-xs text-slate-500">Continue from your saved work. Uses 1 credit on completion.</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
  </div>;
}
