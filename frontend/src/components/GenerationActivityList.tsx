import React from 'react';
import { Box, CheckCircle2, Loader2, AlertCircle, Square } from 'lucide-react';
import { CancelGenerationButton } from './CancelGenerationButton';
import posthog from 'posthog-js';
import { GenerationActivity, isGenerationActive, isPreviewPending } from '../hooks/useGenerationActivity';
import { LlmPreviewLoader } from './LlmPreviewLoader';
import { LlmGenerationOutput } from './LlmGenerationOutput';
import { GenerationElapsedTime } from './GenerationElapsedTime';
import { isAgentGeneration } from '../utils/agentGeneration';
import { ResumeNovaButton } from './ResumeNovaButton';

export function GenerationActivityList({ generations, error, onOpen, onCancelled, onResumed }: {
  generations: GenerationActivity[];
  error: string | null;
  onOpen: (id: string) => void;
  onCancelled?: (id: string) => void;
  onResumed?: (sourceId: string, newId: string) => void;
}) {
  if (!generations.length && !error) return null;
  const activeCount = generations.filter(row => isGenerationActive(row.status)).length;
  const hasActiveNovaBuild = generations.some(row => row.endpoint === 'novaToBricks' && isGenerationActive(row.status));
  return (
    <section aria-label="Your generations" className="mx-auto mb-6 w-full max-w-4xl text-left">
      <div className="mb-4 px-1">
        <h2 className="text-lg font-semibold text-slate-900">Your generations{activeCount > 0 ? ` · ${activeCount} in progress` : ''}</h2>
        <p className="mt-1 text-sm text-slate-500">{hasActiveNovaBuild
          ? "This will take up to 20 minutes. You can close this window safely."
          : "You can leave and come back. Your builds keep running."}</p>
        {error && <p role="status" className="mt-2 text-sm text-amber-700">{error}</p>}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {generations.map(generation => {
          const active = isGenerationActive(generation.status);
          const failed = generation.status === 'failed';
          const cancelled = generation.status === 'cancelled';
          const previewPending = isPreviewPending(generation);
          const agentGeneration = isAgentGeneration(generation.endpoint);
          const label = generation.status === 'queued' ? 'Queued'
            : generation.status === 'completed' ? 'Ready to build'
            : cancelled ? 'Generation cancelled' : failed ? 'Generation failed'
            : generation.endpoint === 'novaToBricks' ? 'Building your full set'
            : agentGeneration ? 'Designing bricks' : 'Building your model';
          return (
            <article key={generation.id} className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="relative h-36 overflow-hidden bg-slate-50">
                {previewPending
                  ? <div role="status" aria-label="Loading model preview" className="flex h-full items-center justify-center"><Loader2 aria-hidden="true" className="h-9 w-9 animate-spin text-slate-400" /></div>
                  : active && (agentGeneration || !generation.imageUrl)
                  ? <LlmPreviewLoader previewImageUrl={generation.imageUrl} compact />
                  : generation.imageUrl
                    ? <img src={generation.imageUrl} alt="" className="h-full w-full object-contain" />
                    : <div className="flex h-full items-center justify-center"><Box className="h-9 w-9 text-slate-300" /></div>}
              </div>
              <div className="p-4">
                <h3 className="break-words text-sm font-semibold text-slate-900">{generation.name || generation.prompt || 'Image reference'}</h3>
                {!(active && agentGeneration) && <p className={`mt-2 flex items-center gap-2 text-sm ${failed ? 'text-red-600' : 'text-slate-600'}`}>
                  {active ? <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin" />
                    : cancelled ? <Square aria-hidden="true" className="h-4 w-4 shrink-0" />
                    : failed ? <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
                    : <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-green-600" />}
                  {label}
                </p>}
                {previewPending && <p className="mt-2 text-xs text-slate-500">Preparing preview…</p>}
                {generation.status === 'completed' && generation.previewWaitUntil && !previewPending && <p className="mt-2 text-xs text-slate-500">Preview unavailable. You can still view your model.</p>}
                {failed && <p className="mt-2 break-words text-xs text-red-600">{generation.errorMessage || 'Please try generating this model again.'}</p>}
                {active && agentGeneration && <LlmGenerationOutput generationId={generation.id} active />}
                {active && <GenerationElapsedTime startedAt={generation.createdAt} />}
                {active && <CancelGenerationButton generationId={generation.id} onCancelled={() => onCancelled?.(generation.id)} />}
                {(failed || cancelled) && generation.endpoint === 'novaToBricks' && onResumed &&
                  <ResumeNovaButton generationId={generation.id} onResumed={id => onResumed(generation.id, id)} />}
                {generation.status === 'completed' && <button type="button"
                  className="mt-3 min-h-10 w-full rounded-full border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  onClick={() => {
                    posthog.capture('landing_generation_opened', { generation_id: generation.id, status: generation.status });
                    onOpen(generation.id);
                  }}>View model</button>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
