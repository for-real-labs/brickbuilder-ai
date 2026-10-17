import React, { lazy, Suspense, useEffect, useState } from 'react';
import posthog from 'posthog-js';
import type { LandingModel } from '../hooks/useLandingModel';
import { LlmPreviewLoader } from './LlmPreviewLoader';
import { LandingModelOrdering } from './LandingModelOrdering';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import './LandingModelWorkspace.css';

const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));

export function modelEditSuggestion(model: LandingModel): string {
  const name = model.generation.name?.trim() || model.generation.prompt?.trim() || 'model';
  const example = model.generation.example_edit_prompt?.trim();
  return example || `Change the colors of the ${name}`;
}

export function LandingModelWorkspace({ model, busy, loading = false, onOrderBarHeightChange, children }: {
  model: LandingModel | null;
  busy: boolean;
  loading?: boolean;
  onOrderBarHeightChange?: (height: number) => void;
  children: React.ReactNode;
}) {
  const generation = model?.generation;
  const { markViewed } = useGenerationNotifications();
  const [readyId, setReadyId] = useState<string | null>(null);
  const [dismissedOrderId, setDismissedOrderId] = useState<string | null>(null);
  const orderable = generation?.orderable !== false && generation?.endpoint !== 'uploadLdraw';
  useEffect(() => {
    if (!generation || readyId !== generation.generation_id || busy) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    const acknowledge = async () => {
      try { await markViewed(readyId); }
      catch { if (!cancelled) retry = setTimeout(acknowledge, 5000); }
    };
    void acknowledge();
    return () => { cancelled = true; clearTimeout(retry); };
  }, [generation?.generation_id, readyId, busy, markViewed]);
  return <>
    {!model && loading && <section className="landing-model-loading" role="status" aria-label="Loading your model">
      <div className="landing-model-loading-animation" aria-hidden="true"><LlmPreviewLoader compact /></div>
      <p>Your model will appear here when it’s ready.</p>
    </section>}
    {model && generation && <section className="landing-model-workspace" aria-label="Your model workspace">
      <div className="landing-model-heading">
        <span className="landing-model-name truncate font-semibold text-slate-800" title={generation.name || generation.prompt || 'Your model'}>{generation.name || generation.prompt || 'Your model'}</span>
      </div>
      <div className="landing-model-stage" aria-label="3D model viewer">
        <Suspense fallback={<p role="status" className="p-6 text-sm text-slate-500">Loading viewer…</p>}>
          <ThreeLDRViewer key={generation.generation_id} modelContent={model.content}
            onModelLoaded={() => setReadyId(generation.generation_id)}
            modelName={generation.name || generation.prompt || 'My model'} generationId={generation.generation_id}
            animateModelBuild showModelControls={false} />
        </Suspense>
      </div>
    </section>}
    <section className="landing-model-conversation" aria-label="Build dialogue">
      {children}
    </section>
    {model && generation && orderable && <LandingModelOrdering key={generation.generation_id}
        model={model} busy={busy} showMobileBar={dismissedOrderId !== generation.generation_id}
        onHeightChange={onOrderBarHeightChange} onDismiss={() => {
          setDismissedOrderId(generation.generation_id);
          posthog.capture('landing_model_order_banner_dismissed', { generation_id: generation.generation_id });
        }} />}
  </>;
}
