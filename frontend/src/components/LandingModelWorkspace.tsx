import React, { lazy, Suspense } from 'react';
import posthog from 'posthog-js';
import type { LandingModel } from '../hooks/useLandingModel';
import './LandingModelWorkspace.css';

const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));

export function modelEditSuggestions(model: LandingModel): string[] {
  const name = model.generation.name?.trim() || model.generation.prompt?.trim() || 'model';
  const example = model.generation.example_edit_prompt?.trim();
  const detail = `Add more detail to the ${name}`;
  return [example || `Change the colors of the ${name}`, example === detail ? `Change the colors of the ${name}` : detail];
}

export function LandingModelWorkspace({ model, busy, onSuggest, onCreateNew, children }: {
  model: LandingModel | null;
  busy: boolean;
  onSuggest: (prompt: string) => void;
  onCreateNew: () => void;
  children: React.ReactNode;
}) {
  const generation = model?.generation;
  return <>
    {model && generation && <section className="landing-model-workspace" aria-label="Your model workspace">
      <div className="landing-model-stage" aria-label="3D model viewer">
        <Suspense fallback={<p role="status" className="p-6 text-sm text-slate-500">Loading 3D viewer…</p>}>
          <ThreeLDRViewer key={generation.generation_id} modelContent={model.content}
            modelName={generation.name || generation.prompt || 'My model'} generationId={generation.generation_id}
            animateModelBuild showModelControls={false} />
        </Suspense>
      </div>
      <div className="landing-model-heading">
        <span className="truncate font-semibold text-slate-800">{generation.name || generation.prompt || 'Your model'}</span>
        <a href={`/generated-model?id=${encodeURIComponent(generation.generation_id)}&exact=1`}
          onClick={() => posthog.capture('landing_model_details_clicked', { generation_id: generation.generation_id })}
          className="shrink-0 rounded-lg px-2 py-2 text-xs font-medium text-slate-600 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Model details ↗</a>
      </div>
    </section>}
    <section className="landing-model-conversation" aria-label="Build dialogue">
      {children}
      {model && generation && <div className="landing-model-suggestions" role="group" aria-label="Model suggestions">
        {modelEditSuggestions(model).map((suggestion, index) => <button key={index} type="button" disabled={busy}
          onClick={() => {
            posthog.capture('landing_model_suggestion_clicked', { generation_id: generation.generation_id, suggestion_index: index });
            onSuggest(suggestion);
          }}>{suggestion}</button>)}
        <button type="button" disabled={busy} className="landing-model-create-new" onClick={onCreateNew}>Create new?</button>
      </div>}
    </section>
  </>;
}
