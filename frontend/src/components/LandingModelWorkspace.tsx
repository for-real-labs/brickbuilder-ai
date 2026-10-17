import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Plus, ShoppingBag } from 'lucide-react';
import posthog from 'posthog-js';
import type { LandingModel } from '../hooks/useLandingModel';
import { LandingModelOrdering } from './LandingModelOrdering';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import './LandingModelWorkspace.css';

const InstructionsViewer = lazy(() => import('../pages/InstructionsPage').then(module => ({ default: module.InstructionsViewer })));
const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));

export function modelEditSuggestion(model: LandingModel): string {
  const name = model.generation.name?.trim() || model.generation.prompt?.trim() || 'model';
  const example = model.generation.example_edit_prompt?.trim();
  return example || `Change the colors of the ${name}`;
}

export function LandingModelWorkspace({ model, busy, onSuggest, onCreateNew, onOrderBarHeightChange, children }: {
  model: LandingModel | null;
  busy: boolean;
  onSuggest: (prompt: string) => void;
  onCreateNew: () => void;
  onOrderBarHeightChange?: (height: number) => void;
  children: React.ReactNode;
}) {
  const generation = model?.generation;
  const { markViewed } = useGenerationNotifications();
  const [readyId, setReadyId] = useState<string | null>(null);
  const [dismissedOrderId, setDismissedOrderId] = useState<string | null>(null);
  const [orderDialogId, setOrderDialogId] = useState<string | null>(null);
  const [instructionsId, setInstructionsId] = useState<string | null>(null);
  const [view, setView] = useState<'model' | 'instructions'>('model');
  const showingInstructions = instructionsId === generation?.generation_id && view === 'instructions';
  const workspace = useRef<HTMLElement>(null);
  const orderButton = useRef<HTMLButtonElement>(null);
  const orderable = generation?.orderable !== false && generation?.endpoint !== 'uploadLdraw';
  useEffect(() => { setOrderDialogId(null); setInstructionsId(null); setView('model'); }, [generation?.generation_id]);
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
    {model && generation && <section ref={workspace} className="landing-model-workspace" data-view={showingInstructions ? 'instructions' : 'model'} aria-label="Your model workspace">
      <div className="landing-model-heading">
        <button type="button" className="landing-model-new-trigger" disabled={busy} onClick={onCreateNew}><Plus size={16} aria-hidden="true" />Create new</button>
        <span className="landing-model-name truncate font-semibold text-slate-800" title={generation.name || generation.prompt || 'Your model'}>{generation.name || generation.prompt || 'Your model'}</span>
        <button ref={orderButton} type="button" className="landing-model-order-trigger" disabled={busy || !orderable}
          aria-haspopup="dialog" aria-expanded={orderDialogId === generation.generation_id} onClick={() => {
            setOrderDialogId(generation.generation_id);
            posthog.capture('landing_model_order_dialog_opened', { generation_id: generation.generation_id, source: 'viewer_header' });
          }}><ShoppingBag size={16} aria-hidden="true" />Order this</button>
      </div>
      <div className="landing-model-stage" aria-label={showingInstructions ? 'Instructions viewer' : '3D model viewer'}>
        <Suspense fallback={<p role="status" className="p-6 text-sm text-slate-500">Loading viewer…</p>}>
          {!showingInstructions && <ThreeLDRViewer key={generation.generation_id} modelContent={model.content}
            onModelLoaded={() => setReadyId(generation.generation_id)}
            modelName={generation.name || generation.prompt || 'My model'} generationId={generation.generation_id}
            animateModelBuild={instructionsId !== generation.generation_id} showModelControls={false} />}
          {instructionsId === generation.generation_id && <div className="landing-instructions-view" hidden={!showingInstructions}>
            <InstructionsViewer key={generation.generation_id} generationId={generation.generation_id} embedded active={showingInstructions} />
          </div>}
        </Suspense>
      </div>
    </section>}
    <section className="landing-model-conversation" aria-label="Build dialogue">
      {children}
      {model && generation && <div className="landing-model-suggestions" role="group" aria-label="Model suggestions">
        <button type="button" disabled={busy}
          onClick={() => {
            posthog.capture('landing_model_suggestion_clicked', { generation_id: generation.generation_id, suggestion_index: 0 });
            onSuggest(modelEditSuggestion(model));
          }}>{modelEditSuggestion(model)}</button>
        <button type="button" disabled={busy} onClick={() => {
          posthog.capture(showingInstructions ? 'landing_model_3d_view_clicked' : 'landing_model_instructions_clicked', { generation_id: generation.generation_id, suggestion_index: 1 });
          setInstructionsId(generation.generation_id);
          setView(showingInstructions ? 'model' : 'instructions');
          workspace.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        }} aria-pressed={showingInstructions}>{showingInstructions ? 'Show model' : 'Show instructions'}</button>
        <button type="button" disabled={busy} className="landing-model-create-new" onClick={onCreateNew}>Create new?</button>
      </div>}
    </section>
    {model && generation && orderable && <LandingModelOrdering key={generation.generation_id}
        model={model} busy={busy} showMobileBar={dismissedOrderId !== generation.generation_id}
        dialogOpen={orderDialogId === generation.generation_id} returnFocusRef={orderButton}
        onCloseDialog={() => {
          setOrderDialogId(null);
          posthog.capture('landing_model_order_dialog_dismissed', { generation_id: generation.generation_id });
        }} onHeightChange={onOrderBarHeightChange} onDismiss={() => {
          setDismissedOrderId(generation.generation_id);
          posthog.capture('landing_model_order_banner_dismissed', { generation_id: generation.generation_id });
        }} />}
  </>;
}
