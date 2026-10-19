import React, { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Box, Maximize2 } from 'lucide-react';
import posthog from 'posthog-js';
import type { LandingModel } from '../hooks/useLandingModel';
import { LandingModelOrdering } from './LandingModelOrdering';
import { ModelShareMenu } from './ModelShareMenu';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import './LandingModelWorkspace.css';

const InstructionsViewer = lazy(() => import('../pages/InstructionsPage').then(module => ({ default: module.InstructionsViewer })));
const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));

export function modelEditSuggestion(model: LandingModel): string {
  const name = model.generation.name?.trim() || model.generation.prompt?.trim() || 'model';
  const example = model.generation.example_edit_prompt?.trim();
  return example || `Change the colors of the ${name}`;
}

export function LandingModelWorkspace({ model, busy, requestedInstructionsId, onOrderBarHeightChange, children }: {
  model: LandingModel | null;
  busy: boolean;
  requestedInstructionsId?: string | null;
  onOrderBarHeightChange?: (height: number) => void;
  children: React.ReactNode;
}) {
  const generation = model?.generation;
  const { markViewed } = useGenerationNotifications();
  const [readyId, setReadyId] = useState<string | null>(null);
  const [dismissedOrderId, setDismissedOrderId] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const stageId = useId();
  const [instructionsId, setInstructionsId] = useState<string | null>(null);
  const [view, setView] = useState<'model' | 'instructions'>('model');
  const [expanded, setExpanded] = useState(false);
  const panel = useRef<HTMLDialogElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const showingInstructions = instructionsId === generation?.generation_id && view === 'instructions';
  useEffect(() => {
    const openInstructions = Boolean(generation && requestedInstructionsId === generation.generation_id);
    setInstructionsId(openInstructions ? generation!.generation_id : null);
    setView(openInstructions ? 'instructions' : 'model');
    setExpanded(openInstructions);
    if (openInstructions) posthog.capture('landing_model_view_expanded', {
      generation_id: generation!.generation_id, view: 'instructions', source: 'url',
    });
  }, [generation?.generation_id, requestedInstructionsId]);
  useEffect(() => {
    const dialog = panel.current;
    if (!expanded || !dialog) return;
    // Promote the same panel to the top layer so camera and instruction state survive.
    dialog.close();
    dialog.showModal();
    backButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      dialog.close();
      if (dialog.isConnected) dialog.show();
      document.body.style.overflow = previousOverflow;
      expandButton.current?.focus();
    };
  }, [expanded, generation?.generation_id]);
  const collapse = (source: 'back_button' | 'escape') => {
    posthog.capture('landing_model_view_collapsed', {
      generation_id: generation?.generation_id, view: showingInstructions ? 'instructions' : 'model', source,
    });
    setExpanded(false);
  };
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Let the viewer handle rotation/zoom without passing gestures to the page.
    // Instruction navigation and the parts list keep their normal scrolling.
    const preventPageScroll = (event: Event) => {
      if (element.dataset.view === 'instructions'
        && !(event.target instanceof Element && event.target.closest('.instructions-canvas'))) return;
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener('touchmove', preventPageScroll, { passive: false });
    element.addEventListener('wheel', preventPageScroll, { passive: false });
    return () => {
      element.removeEventListener('touchmove', preventPageScroll);
      element.removeEventListener('wheel', preventPageScroll);
    };
  }, [generation?.generation_id]);
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
    {model && generation && <dialog ref={panel} open className="landing-model-panel"
      data-expanded={expanded} data-view={showingInstructions ? 'instructions' : 'model'}
      role={expanded ? 'dialog' : 'region'} aria-modal={expanded || undefined}
      aria-label={expanded ? (showingInstructions ? 'Expanded instructions' : 'Expanded 3D viewer') : 'Model preview'}
      onCancel={event => { event.preventDefault(); collapse('escape'); }}>
      <div className="landing-expanded-header" hidden={!expanded}>
        <button ref={backButton} type="button" className="landing-action-button landing-view-back" onClick={() => collapse('back_button')}>
          <ArrowLeft size={20} aria-hidden="true" /><span>Back to builder</span>
        </button>
        <span className="landing-expanded-label">{showingInstructions ? 'Instructions' : '3D viewer'}</span>
      </div>
      <section className="landing-model-workspace" data-view={showingInstructions ? 'instructions' : 'model'} aria-label="Your model workspace">
        <div className="landing-model-heading">
          <span className="landing-model-name truncate font-semibold text-slate-800" title={generation.name || generation.prompt || 'Your model'}>{generation.name || generation.prompt || 'Your model'}</span>
        </div>
        {!showingInstructions && !busy && generation.endpoint !== 'uploadLdraw' && <div className="landing-model-share">
          <ModelShareMenu generationId={generation.generation_id} modelName={generation.name || generation.prompt || 'My model'} />
        </div>}
        <div ref={stage} id={stageId} className="landing-model-stage" data-view={showingInstructions ? 'instructions' : 'model'} aria-label={showingInstructions ? 'Instructions viewer' : '3D model viewer'}>
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
      </section>
      <div className="landing-model-toolbar">
        <button type="button" className="landing-action-button landing-instructions-toggle" disabled={busy}
          aria-pressed={showingInstructions} aria-controls={stageId} onClick={() => {
            posthog.capture(showingInstructions ? 'landing_model_3d_view_clicked' : 'landing_model_instructions_clicked', {
              generation_id: generation.generation_id, source: 'viewer_footer',
            });
            setInstructionsId(generation.generation_id);
            setView(showingInstructions ? 'model' : 'instructions');
          }}>
          {showingInstructions ? <Box size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}
          <span>{showingInstructions ? 'Show model' : 'Show instructions'}</span>
        </button>
        <button ref={expandButton} type="button" className="landing-action-button landing-view-expand" hidden={expanded}
          aria-label={showingInstructions ? 'Expand instructions' : 'Expand 3D viewer'} aria-haspopup="dialog"
          onClick={() => {
            posthog.capture('landing_model_view_expanded', {
              generation_id: generation.generation_id, view: showingInstructions ? 'instructions' : 'model', source: 'viewer_footer',
            });
            setExpanded(true);
          }}>
          <Maximize2 size={16} aria-hidden="true" /><span>Expand view</span>
        </button>
      </div>
    </dialog>}
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
