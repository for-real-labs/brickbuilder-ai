import React, { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Box, Maximize2, Sparkles } from 'lucide-react';
import posthog from 'posthog-js';
import type { LandingModel } from '../hooks/useLandingModel';
import { LandingModelOrdering } from './LandingModelOrdering';
import { ModelShareMenu } from './ModelShareMenu';
import { GenerationTitle } from './GenerationTitle';
import { LdrawGenerationAnimation } from './LdrawGenerationAnimation';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import { useBilling } from '../contexts/BillingContext';
import { PaidFeatureLock } from './PaidFeatureDialog';
import './LandingModelWorkspace.css';

const InstructionsViewer = lazy(() => import('../pages/InstructionsPage').then(module => ({ default: module.InstructionsViewer })));
const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));

export function modelEditSuggestion(model: LandingModel): string {
  const name = model.generation.name?.trim() || model.generation.prompt?.trim() || 'model';
  const example = model.generation.example_edit_prompt?.trim();
  return example || `Change the colors of the ${name}`;
}

export function LandingModelWorkspace({ model, busy, pendingEdit = false, building = false, composerFocused = false, requestedInstructionsId, onCreateNew, createNewDisabled = false, onOrderBarHeightChange, canRename = false, accessToken, onRenameRequest, onNameSaved, children }: {
  model: LandingModel | null;
  busy: boolean;
  pendingEdit?: boolean;
  building?: boolean;
  composerFocused?: boolean;
  requestedInstructionsId?: string | null;
  onCreateNew?: () => void;
  createNewDisabled?: boolean;
  onOrderBarHeightChange?: (height: number) => void;
  canRename?: boolean;
  accessToken?: string;
  onRenameRequest?: () => void;
  onNameSaved?: (id: string, name: string) => void;
  children: React.ReactNode;
}) {
  const generation = model?.generation;
  const { markViewed } = useGenerationNotifications();
  const { getFeatureAccess, requireFeature } = useBilling();
  const featureAccess = getFeatureAccess('instructions', generation?.generation_id);
  const promptedInstructions = useRef<string | null>(null);
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
  const collapseRef = useRef<(source: 'back_button' | 'escape') => void>(() => {});
  const showingInstructions = featureAccess === 'allowed' && !pendingEdit && instructionsId === generation?.generation_id && view === 'instructions';
  useEffect(() => {
    const openInstructions = Boolean(featureAccess === 'allowed' && generation && requestedInstructionsId === generation.generation_id);
    setInstructionsId(openInstructions ? generation!.generation_id : null);
    setView(openInstructions ? 'instructions' : 'model');
    setExpanded(openInstructions);
    if (openInstructions) posthog.capture('landing_model_view_expanded', {
      generation_id: generation!.generation_id, view: 'instructions', source: 'url',
    });
  }, [generation?.generation_id, requestedInstructionsId, featureAccess]);
  useEffect(() => {
    if (generation && requestedInstructionsId === generation.generation_id && featureAccess !== 'allowed'
      && featureAccess !== 'loading' && promptedInstructions.current !== generation.generation_id) {
      promptedInstructions.current = generation.generation_id;
      requireFeature('instructions', 'instructions_link', generation.generation_id);
    }
  }, [generation?.generation_id, requestedInstructionsId, featureAccess, requireFeature]);
  useEffect(() => {
    const dialog = panel.current;
    if (!expanded || !dialog) return;
    const header = dialog.closest('.landing-page')?.querySelector('.landing-page-shell > header');
    const updateTop = () => {
      if (!header) return;
      const pageTop = dialog.closest('.landing-page')?.getBoundingClientRect().top ?? 0;
      dialog.style.setProperty('--landing-expanded-top', `${Math.ceil(header.getBoundingClientRect().bottom - pageTop) + 16}px`);
    };
    updateTop();
    const observer = header && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateTop) : null;
    if (header) observer?.observe(header);
    window.addEventListener('resize', updateTop);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); collapseRef.current('escape'); }
    };
    document.addEventListener('keydown', onKeyDown);
    backButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateTop);
      document.removeEventListener('keydown', onKeyDown);
      dialog.style.removeProperty('--landing-expanded-top');
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
  useEffect(() => { collapseRef.current = collapse; });
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
    {!model && building && <section className="landing-generation-workspace" aria-label="Build progress workspace">
      <LdrawGenerationAnimation />
    </section>}
    {model && generation && <div className={`landing-model-layout${orderable ? ' landing-model-layout--orderable' : ''}`}>
    <dialog ref={panel} open className="landing-model-panel"
      data-expanded={expanded} data-view={showingInstructions ? 'instructions' : 'model'}
      role={expanded ? 'dialog' : 'region'}
      aria-label={expanded ? (showingInstructions ? 'Expanded instructions' : 'Expanded 3D viewer') : 'Model preview'}
      onCancel={event => { event.preventDefault(); collapse('escape'); }}>
      {!pendingEdit && !showingInstructions && <GenerationTitle key={generation.generation_id} variant="viewer"
        name={generation.name || generation.prompt || 'My model'} generationId={generation.generation_id}
        canEdit={canRename && !busy} accessToken={accessToken} onEditRequest={onRenameRequest}
        onSaved={name => onNameSaved?.(generation.generation_id, name)} />}
      <section className="landing-model-workspace" data-view={pendingEdit ? 'building' : showingInstructions ? 'instructions' : 'model'} aria-label="Your model workspace">
        <div ref={stage} id={stageId} className="landing-model-stage" data-view={pendingEdit ? 'building' : showingInstructions ? 'instructions' : 'model'} aria-label={pendingEdit ? 'Building your edited model' : showingInstructions ? 'Instructions viewer' : '3D model viewer'}>
          {pendingEdit ? <LdrawGenerationAnimation /> :
          <Suspense fallback={<p role="status" className="p-6 text-sm text-slate-500">Loading viewer…</p>}>
            {!showingInstructions && <ThreeLDRViewer key={generation.generation_id} modelContent={model.content}
              onModelLoaded={() => setReadyId(generation.generation_id)}
              modelName={generation.name || generation.prompt || 'My model'} generationId={generation.generation_id}
              animateModelBuild={instructionsId !== generation.generation_id} showModelControls={false} defaultShowRuler />}
            {featureAccess === 'allowed' && instructionsId === generation.generation_id && <div className="landing-instructions-view" hidden={!showingInstructions}>
              <InstructionsViewer key={generation.generation_id} generationId={generation.generation_id} embedded active={showingInstructions} />
            </div>}
          </Suspense>}
        </div>
        {!pendingEdit && <div className="landing-model-toolbar">
          {onCreateNew && <button type="button" className="landing-create-new landing-action-button" disabled={createNewDisabled} onClick={onCreateNew}>
            <Sparkles size={16} aria-hidden="true" /><span>Create new</span>
          </button>}
          <button ref={expandButton} type="button" className="landing-action-button landing-view-expand" hidden={expanded}
            aria-label={showingInstructions ? 'Expand instructions' : 'Expand 3D viewer'}
            title={showingInstructions ? 'Expand instructions' : 'Expand 3D viewer'} aria-haspopup="dialog"
            onClick={() => {
              posthog.capture('landing_model_view_expanded', {
                generation_id: generation.generation_id, view: showingInstructions ? 'instructions' : 'model', source: 'viewer_footer',
              });
              setExpanded(true);
            }}>
            <Maximize2 size={18} aria-hidden="true" />
          </button>
        </div>}
        {!pendingEdit && <div className="landing-model-bottom-toolbar">
          <button type="button" className="landing-action-button landing-instructions-toggle" disabled={busy}
            aria-pressed={showingInstructions} aria-controls={stageId} onClick={() => {
              if (!showingInstructions && !requireFeature('instructions', 'viewer_footer', generation.generation_id)) return;
              posthog.capture(showingInstructions ? 'landing_model_3d_view_clicked' : 'landing_model_instructions_clicked', {
                generation_id: generation.generation_id, source: 'viewer_footer',
              });
              setInstructionsId(generation.generation_id);
              setView(showingInstructions ? 'model' : 'instructions');
            }}>
            {showingInstructions ? <Box size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}
            <span>{showingInstructions ? 'Show model' : 'Show instructions'}</span>
            {featureAccess !== 'allowed' && <PaidFeatureLock />}
          </button>
          {!busy && !showingInstructions && generation.endpoint !== 'uploadLdraw' && <div className="landing-model-share">
            <ModelShareMenu generationId={generation.generation_id} modelName={generation.name || generation.prompt || 'My model'} placement="above" />
          </div>}
        </div>}
      </section>
      <div className="landing-expanded-footer" hidden={!expanded}>
        <button ref={backButton} type="button" className="landing-action-button landing-view-back" onClick={() => collapse('back_button')}>
          <ArrowLeft size={20} aria-hidden="true" /><span>Go Back</span>
        </button>
      </div>
    </dialog>
    {orderable && !pendingEdit && <LandingModelOrdering key={generation.generation_id}
        model={model} busy={busy} showMobileBar={dismissedOrderId !== generation.generation_id && !composerFocused}
        onHeightChange={onOrderBarHeightChange} onDismiss={() => {
          setDismissedOrderId(generation.generation_id);
          posthog.capture('landing_model_order_banner_dismissed', { generation_id: generation.generation_id });
        }} />}
    </div>}
    <section className={`landing-model-conversation${model ? ' landing-model-conversation--model-card' : ''}`} aria-label="Build dialogue">
      {children}
    </section>
  </>;
}
