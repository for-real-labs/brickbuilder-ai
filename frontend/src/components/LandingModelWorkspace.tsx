import React, { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Maximize2, Minimize2, Ruler } from 'lucide-react';
import posthog from 'posthog-js';
import type { LandingModel } from '../hooks/useLandingModel';
import { LandingModelOrdering } from './LandingModelOrdering';
import { LandingPreviousEdits } from './LandingPreviousEdits';
import { LandingCommunityAction } from './LandingCommunityAction';
import { ModelShareMenu } from './ModelShareMenu';
import { GenerationTitle } from './GenerationTitle';
import { LdrawGenerationAnimation } from './LdrawGenerationAnimation';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import { useBilling } from '../contexts/BillingContext';
import { PaidFeatureLock } from './PaidFeatureDialog';
import './LandingModelWorkspace.css';

const InstructionsViewer = lazy(() => import('../pages/InstructionsPage').then(module => ({ default: module.InstructionsViewer })));
const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));

type ViewerCollapseSource = 'back_button' | 'escape' | 'viewer_toolbar';

export function modelEditSuggestion(model: LandingModel): string {
  const name = model.generation.name?.trim() || model.generation.prompt?.trim() || 'model';
  const example = model.generation.example_edit_prompt?.trim();
  return example || `Change the colors of the ${name}`;
}

export function LandingModelWorkspace({ model, busy, pendingEdit = false, building = false, composerFocused = false, onOrderBarHeightChange, canRename = false, accessToken, onRenameRequest, onNameSaved, onViewPreviousEdit, historyId, onNoVersion, onConvertKit, children }: {
  model: LandingModel | null;
  busy: boolean;
  pendingEdit?: boolean;
  building?: boolean;
  composerFocused?: boolean;
  onOrderBarHeightChange?: (height: number) => void;
  canRename?: boolean;
  accessToken?: string;
  onRenameRequest?: () => void;
  onNameSaved?: (id: string, name: string) => void;
  onViewPreviousEdit?: (id: string, historyId?: string) => void;
  historyId?: string;
  onNoVersion?: () => void;
  onConvertKit?: () => void;
  children: React.ReactNode;
}) {
  const generation = model?.generation;
  const generationId = generation?.generation_id;
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedInstructionsId = searchParams.get('instructions') === '1' ? searchParams.get('id') : null;
  const linkedStep = searchParams.get('step');
  const { markViewed } = useGenerationNotifications();
  const { getFeatureAccess, requireFeature } = useBilling();
  const featureAccess = getFeatureAccess('instructions', generation?.generation_id);
  const promptedInstructions = useRef<string | null>(null);
  const [readyId, setReadyId] = useState<string | null>(null);
  const [dismissedOrderId, setDismissedOrderId] = useState<string | null>(null);
  const preview = useRef<{ id: string; png: string } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const stageId = useId();
  const [instructionsId, setInstructionsId] = useState<string | null>(null);
  const lastInstructionStep = useRef<{ id: string; step: number } | null>(null);
  const [showRuler, setShowRuler] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<(source: ViewerCollapseSource) => void>(() => {});
  const showingInstructions = featureAccess === 'allowed' && !pendingEdit && generationId === requestedInstructionsId;
  const expandLabel = showingInstructions ? (expanded ? 'Exit expanded instructions' : 'Expand instructions') : 'Expand 3D viewer';
  useEffect(() => {
    setInstructionsId(id => id === generationId ? id : null);
    setExpanded(false);
  }, [generationId]);
  useEffect(() => {
    if (!showingInstructions || !generationId || instructionsId === generationId) return;
    setInstructionsId(generationId);
    setExpanded(true);
    posthog.capture('landing_model_view_expanded', {
      generation_id: generationId, view: 'instructions', source: 'url',
    });
  }, [showingInstructions, generationId, instructionsId]);
  const setInstructionUrl = useCallback((step: number | null | undefined) => {
    if (!generationId) return;
    if (typeof step === 'number' && requestedInstructionsId === generationId && linkedStep === String(step)) return;
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      if (step === null) {
        next.delete('instructions');
        next.delete('step');
      } else {
        next.set('id', generationId);
        next.set('instructions', '1');
        if (step === undefined) next.delete('step');
        else next.set('step', String(step));
      }
      return next;
    }, { replace: true, ...(historyId && { state: { forkHistoryId: historyId } }) });
  }, [generationId, historyId, requestedInstructionsId, linkedStep, setSearchParams]);
  const onInstructionStepChange = useCallback((step: number) => {
    if (!generationId || !showingInstructions) return;
    lastInstructionStep.current = { id: generationId, step };
    setInstructionUrl(step);
  }, [generationId, showingInstructions, setInstructionUrl]);
  useEffect(() => {
    if (generation && requestedInstructionsId === generation.generation_id && featureAccess !== 'allowed'
      && featureAccess !== 'loading' && promptedInstructions.current !== generation.generation_id) {
      promptedInstructions.current = generation.generation_id;
      requireFeature('instructions', 'instructions_link', generation.generation_id);
    }
  }, [generation?.generation_id, requestedInstructionsId, featureAccess, requireFeature]);
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('.landing-community-dialog[open], .landing-previous-edits-dialog[open]')) { event.preventDefault(); collapseRef.current('escape'); }
    };
    document.addEventListener('keydown', onKeyDown);
    backButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      expandButton.current?.focus();
    };
  }, [expanded, generation?.generation_id]);
  const collapse = (source: ViewerCollapseSource) => {
    posthog.capture('landing_model_view_collapsed', {
      generation_id: generation?.generation_id, view: showingInstructions ? 'instructions' : 'model', source,
    });
    setExpanded(false);
    if (showingInstructions && source === 'back_button' && window.matchMedia('(min-width: 900px)').matches) {
      setInstructionUrl(null);
    }
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
  const orderable = generation?.endpoint === 'uploadLdraw' ? Boolean(onConvertKit) : generation?.orderable !== false;
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
  const backToModelButton = showingInstructions && <button type="button" className="instructions-heading-button" disabled={busy}
    aria-controls={stageId} onClick={() => {
      posthog.capture('landing_model_3d_view_clicked', { generation_id: generationId, source: 'instructions_header' });
      setInstructionUrl(null);
      (expanded ? backButton : expandButton).current?.focus();
    }}>Back to model</button>;
  return <>
    {!model && building && <section className="landing-generation-workspace" aria-label="Build progress workspace">
      <LdrawGenerationAnimation />
    </section>}
    {model && generation && <div className={`landing-model-layout${orderable ? ' landing-model-layout--orderable' : ''}`}>
    <dialog open className="landing-model-panel"
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
          <Suspense fallback={<div className="instructions-inline-message"><p role="status">Loading viewer…</p>{backToModelButton}</div>}>
            {!showingInstructions && <ThreeLDRViewer key={generation.generation_id} modelContent={model.content}
              onModelLoaded={() => setReadyId(generation.generation_id)}
              onPreviewCaptured={png => { preview.current = { id: generation.generation_id, png }; }}
              modelName={generation.name || generation.prompt || 'My model'} generationId={generation.generation_id}
              animateModelBuild={instructionsId !== generation.generation_id} showModelControls={false} showRuler={showRuler} />}
            {featureAccess === 'allowed' && instructionsId === generation.generation_id && <div className="landing-instructions-view" hidden={!showingInstructions}>
              <InstructionsViewer key={generation.generation_id} generationId={generation.generation_id}
                initialStep={linkedStep === null ? undefined : Number(linkedStep)} onStepChange={onInstructionStepChange} embedded active={showingInstructions}
                backToModelButton={backToModelButton} />
            </div>}
          </Suspense>}
        </div>
        {!pendingEdit && <div className="landing-model-toolbar">
          <div className="landing-view-controls">
          {!showingInstructions && <button type="button" className="landing-action-button landing-ruler-toggle"
            aria-label={showRuler ? 'Hide ruler' : 'Show ruler'} title={showRuler ? 'Hide ruler' : 'Show ruler'}
            aria-pressed={showRuler} aria-controls={stageId} onClick={() => {
              setShowRuler(!showRuler);
              posthog.capture('landing_model_ruler_toggled', {
                generation_id: generation.generation_id, visible: !showRuler, source: 'viewer_toolbar',
              });
            }}>
            <span className="landing-ruler-icon"><Ruler size={18} aria-hidden="true" />
              {!showRuler && <svg className="landing-ruler-slash" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 21 21 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>}
            </span>
          </button>}
          <button ref={expandButton} type="button" className="landing-action-button landing-view-expand" hidden={expanded && !showingInstructions}
            aria-label={expandLabel} title={expandLabel} aria-expanded={expanded} aria-haspopup={expanded ? undefined : 'dialog'}
            onClick={() => {
              if (expanded) {
                collapse('viewer_toolbar');
                return;
              }
              posthog.capture('landing_model_view_expanded', {
                generation_id: generation.generation_id, view: showingInstructions ? 'instructions' : 'model', source: 'viewer_footer',
              });
              setExpanded(true);
            }}>
            {expanded ? <Minimize2 size={18} aria-hidden="true" /> : <Maximize2 size={18} aria-hidden="true" />}
          </button>
          </div>
        </div>}
        {!pendingEdit && !busy && !showingInstructions && generation.endpoint !== 'uploadLdraw' && <div className="landing-model-share landing-model-share-overlay">
            <ModelShareMenu generationId={generation.generation_id} modelName={generation.name || generation.prompt || 'My model'} placement="above" />
          </div>}
      </section>
      {!pendingEdit && <div key={`actions-${generation.generation_id}`} className="landing-model-bottom-toolbar" hidden={expanded}>
          {!showingInstructions && <button type="button" className="landing-action-button landing-instructions-toggle" disabled={busy}
            aria-controls={stageId} onClick={() => {
              if (!requireFeature('instructions', 'viewer_footer', generation.generation_id)) return;
              posthog.capture('landing_model_instructions_clicked', {
                generation_id: generation.generation_id, source: 'viewer_footer',
              });
              setInstructionsId(generation.generation_id);
              const lastStep = lastInstructionStep.current;
              setInstructionUrl(lastStep?.id === generation.generation_id ? lastStep.step : undefined);
            }}>
            <BookOpen size={16} aria-hidden="true" />
            <span>Show instructions</span>
            {featureAccess !== 'allowed' && <PaidFeatureLock />}
          </button>}
          {onViewPreviousEdit && <LandingPreviousEdits id={generation.generation_id}
            historyId={historyId} token={accessToken} busy={busy} onView={onViewPreviousEdit} onNoVersion={onNoVersion} />}
          {!historyId && generation.endpoint !== 'uploadLdraw' && <LandingCommunityAction
            id={generation.generation_id} busy={busy} onNameSaved={onNameSaved}
            preview={() => preview.current?.id === generation.generation_id ? preview.current.png : undefined} />}
      </div>}
      <div className="landing-expanded-footer" hidden={!expanded}>
        <button ref={backButton} type="button" className="landing-action-button landing-view-back" onClick={() => collapse('back_button')}>
          <ArrowLeft size={20} aria-hidden="true" /><span>Go Back</span>
        </button>
      </div>
    </dialog>
    {orderable && !pendingEdit && <LandingModelOrdering key={generation.generation_id}
        model={model} busy={busy} onConvert={onConvertKit} showMobileBar={dismissedOrderId !== generation.generation_id && !composerFocused}
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
