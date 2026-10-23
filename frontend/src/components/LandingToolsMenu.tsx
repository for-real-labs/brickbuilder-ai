import React, { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Box, ChevronDown, Download, Upload, Github, Image, LifeBuoy, MessageSquare, Settings, Users, Wrench } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { usePet } from '../contexts/PetContext';
import { BUDDY_TOOL_ROUTES, type BuddyToolIntent } from '../utils/buddyTools';
import posthog from 'posthog-js';
import { PetSwitchButton } from './PetCompanion';
import { FeedbackWidget } from './FeedbackWidget';
import { SupportDialog } from './SupportDialog';
import type { LandingModel } from '../hooks/useLandingModel';
import { downloadModel, type ModelExportFormat } from '../utils/modelExport';
import { useBilling } from '../contexts/BillingContext';
import { PaidFeatureLock } from './PaidFeatureDialog';

const tools = [
  { label: 'Image to LEGO', path: '/image-to-lego', icon: Image, event: 'landing_header_image_to_lego_clicked' },
  { label: 'GLB to LEGO', path: '/glb-to-lego', icon: Box, event: 'landing_header_glb_to_lego_clicked' },
  { label: 'OBJ to LEGO', path: '/obj-to-lego', icon: Box, event: 'landing_header_obj_to_lego_clicked' },
];

export interface GenerationSettingsAction {
  open: boolean;
  controls: string;
  onOpen: (returnFocusTo: HTMLButtonElement) => void;
}

export interface LandingToolsHandle {
  runTool: (action: BuddyToolIntent, expectedGenerationId?: string) => string;
}

export const LandingToolsMenu = React.forwardRef<LandingToolsHandle, {
  page: string; generationSettings?: GenerationSettingsAction; model?: LandingModel | null; busy?: boolean;
}>(function LandingToolsMenu({ page, generationSettings, model, busy = false }, ref) {
  const navigate = useNavigate();
  const { openPicker } = usePet();
  const { featureAccess, requireFeature } = useBilling();
  const focusChoices = useRef(false);
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'export' | 'import' | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const rowClass = 'flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336] disabled:cursor-not-allowed disabled:opacity-40';
  const [feedbackOpen, setFeedbackOpen] = useState<boolean | null>(null);
  const [supportOpen, setSupportOpen] = useState<boolean | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [panelLeft, setPanelLeft] = useState(0);
  const attribution = () => ({ page, navigation_layout: 'tools_dropdown' });

  useEffect(() => {
    setOpen(false);
    posthog.capture('landing_header_tools_shown', { page, navigation_layout: 'tools_dropdown' });
  }, [page]);

  useEffect(() => { if (!open) { setSubmenu(null); setExportError(null); } }, [open]);
  useEffect(() => { setSubmenu(null); setExportError(null); }, [model?.generation.generation_id]);
  useLayoutEffect(() => {
    if (open && focusChoices.current) {
      focusChoices.current = false;
      (container.current?.querySelector<HTMLElement>('ul ul button:not(:disabled), ul ul a') ?? trigger.current)?.focus();
    }
  }, [open, submenu]);

  const exportModel = (format: ModelExportFormat, source = 'tools_dropdown') => {
    if ((format === 'ldraw' || format === 'io') && !requireFeature(format, source)) {
      setOpen(false);
      trigger.current?.focus();
      return false;
    }
    if (!model) throw new Error('Open or create a model first, then ask me to download it.');
    if (busy) throw new Error('Your model is still updating. Try the download when it finishes.');
    posthog.capture('landing_model_export_clicked', { ...attribution(), generation_id: model.generation.generation_id, format, source });
    downloadModel(model.content, model.generation.name || model.generation.prompt || 'model', format);
    setOpen(false);
    return true;
  };

  useImperativeHandle(ref, () => ({ runTool(action, expectedGenerationId) {
    try {
      let reply: string;
      const route = BUDDY_TOOL_ROUTES[action];
      if (route) {
        setOpen(false);
        navigate(route);
        reply = action === 'community' ? 'Opening Community.' : 'Choose your file on the page I opened.';
      } else if (action.startsWith('export_')) {
        if (expectedGenerationId !== model?.generation.generation_id) throw new Error('The selected model changed. Ask again to download the model now shown.');
        reply = exportModel(action.slice(7) as ModelExportFormat, 'buddy_chat')
          ? 'Starting your download.' : 'LDR and IO exports require a paid plan. I opened the plan access popup.';
      } else if (action === 'export' || action === 'import') {
        focusChoices.current = true;
        setOpen(true);
        setSubmenu(action);
        reply = action === 'export' ? 'Choose a download format in Tools.' : 'Choose LDraw or IO in Tools.';
      } else {
        setOpen(false);
        switch (action) {
          case 'generation_settings':
            if (!generationSettings || !trigger.current) throw new Error('Generation settings are available on the builder page.');
            generationSettings.onOpen(trigger.current);
            reply = 'Generation settings are open.';
            break;
          case 'buddy_settings':
            openPicker('buddy_chat', trigger.current);
            reply = 'Choose your Build Buddy or motion settings.';
            break;
          case 'feedback': setFeedbackOpen(true); reply = 'The feedback form is open. Add your message and press Send.'; break;
          case 'support': setSupportOpen(true); reply = 'The support form is open. Add your email and message, then press Send.'; break;
          case 'github': window.location.assign('https://github.com/for-real-labs/brickbuilder-ai'); reply = 'Opening GitHub.'; break;
          default: throw new Error('I couldn’t open that tool. Try the Tools menu.');
        }
      }
      posthog.capture('build_buddy_tool_used', { action, has_model: Boolean(model) });
      return reply;
    } catch (error) {
      posthog.capture('build_buddy_tool_failed', { action, has_model: Boolean(model) });
      return error instanceof Error ? error.message : 'I couldn’t use that tool. Try the Tools menu.';
    }
  } }));

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const bounds = container.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(256, window.innerWidth - 32);
      setPanelLeft(Math.max(16, Math.min(bounds.right - width, window.innerWidth - width - 16)) - bounds.left);
    };
    position();
    window.addEventListener('resize', position);
    return () => window.removeEventListener('resize', position);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismissOutside);
    return () => document.removeEventListener('pointerdown', dismissOutside);
  }, [open]);

  return <div ref={container} className="relative" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" aria-label="Tools" title="Tools" aria-expanded={open} aria-controls={panelId}
      className="inline-flex h-9 w-9 cursor-pointer items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/90 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:border-red-200 hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2 sm:w-auto sm:px-3"
      onClick={() => {
        if (!open) posthog.capture('landing_header_tools_opened', attribution());
        setOpen(!open);
      }}>
      <Wrench aria-hidden="true" className="h-4 w-4" /><span className="hidden sm:inline">Tools</span>
      <ChevronDown aria-hidden="true" className={`hidden h-3.5 w-3.5 transition-transform sm:block ${open ? 'rotate-180' : ''}`} />
    </button>
    {open && <div id={panelId} style={{ left: panelLeft }} className="absolute top-full z-[60] mt-2 max-h-[calc(var(--landing-viewport-height,100dvh)-5rem)] w-64 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl">
      <ul aria-label="Tools" className="m-0 list-none p-0">
        {(['import', 'export'] as const).map(action => <li key={action}>
          <button type="button" className={rowClass} aria-expanded={submenu === action} aria-controls={`${panelId}-${action}`}
            onClick={() => {
              posthog.capture('landing_header_tools_item_clicked', { ...attribution(), tool: action === 'export' ? 'Export' : 'Import' });
              setSubmenu(submenu === action ? null : action);
              setExportError(null);
            }}>
            {action === 'export' ? <Download aria-hidden="true" className="h-4 w-4 shrink-0" /> : <Upload aria-hidden="true" className="h-4 w-4 shrink-0" />}
            {action === 'export' ? 'Export' : 'Import'}<ChevronDown aria-hidden="true" className={`ml-auto h-4 w-4 ${submenu === action ? 'rotate-180' : ''}`} />
          </button>
          {submenu === action && <ul id={`${panelId}-${action}`} aria-label={action === 'export' ? 'Export options' : 'Import options'} className="mx-1 mb-1 list-none rounded-xl bg-slate-50 p-1">
            {action === 'export' ? <>
              {([['ldraw', 'Download LDraw'], ['io', 'Download IO'], ['csv', 'Download parts list CSV'], ['xml', 'Download parts list XML']] as [ModelExportFormat, string][]).map(([format, label]) => <li key={format} className={format === 'csv' ? 'mt-1 border-t border-slate-200 pt-1' : ''}>
                <button type="button" className={rowClass} disabled={!((format === 'ldraw' || format === 'io') && featureAccess !== 'allowed') && (!model || busy)} onClick={() => {
                  try {
                    exportModel(format);
                  } catch (error) {
                    setExportError(error instanceof Error ? error.message : 'Unable to download this model. Please try again.');
                    posthog.capture('landing_model_export_failed', { ...attribution(), generation_id: model?.generation.generation_id, format });
                  }
                }}>{label}{(format === 'ldraw' || format === 'io') && featureAccess !== 'allowed' && <PaidFeatureLock />}</button>
              </li>)}
              {(!model || busy) && <li className="px-3 py-2 text-xs text-slate-500">{busy ? 'Downloads will be ready when your model finishes.' : 'Open or generate a model to download it.'}</li>}
              {exportError && <li role="alert" className="px-3 py-2 text-xs text-red-600">{exportError}</li>}
            </> : (['ldraw', 'io'] as const).map(format => <li key={format}>
              <Link className={rowClass} to={`/use-ai-to-edit-ldraw?format=${format}`} onClick={() => {
                posthog.capture('landing_header_tools_item_clicked', { ...attribution(), tool: `Import ${format === 'io' ? 'IO' : 'LDraw'}`, format });
                posthog.capture('landing_header_upload_ldraw_clicked', { ...attribution(), format });
                setOpen(false);
              }}>Import {format === 'io' ? 'IO' : 'LDraw'}</Link>
            </li>)}
          </ul>}
        </li>)}
        <li role="separator" className="my-1 border-t border-slate-200" />
        {generationSettings && <>
          <li>
            <button type="button" aria-label="Generation settings" aria-expanded={generationSettings.open} aria-controls={generationSettings.controls}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]"
              onClick={() => {
                posthog.capture('landing_header_tools_item_clicked', { ...attribution(), tool: 'Generation settings' });
                setOpen(false);
                if (trigger.current) generationSettings.onOpen(trigger.current);
              }}>
              <Settings aria-hidden="true" className="h-4 w-4 shrink-0" />Generation settings
            </button>
          </li>
          <li role="separator" className="my-1 border-t border-slate-200" />
        </>}
        {tools.map(({ label, path, icon: Icon, event }) => <li key={path}>
          <Link to={path} className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]"
            onClick={() => {
              const properties = { ...attribution(), destination: path, tool: label };
              posthog.capture('landing_header_tools_item_clicked', properties);
              posthog.capture(event, properties);
              setOpen(false);
            }}>
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />{label}
          </Link>
        </li>)}
        <li role="separator" className="my-1 border-t border-slate-200" />
        <li>
          <PetSwitchButton source="landing_tools" returnFocusRef={trigger} onOpen={() => setOpen(false)}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]" />
        </li>
        <li role="separator" className="my-1 border-t border-slate-200" />
        <li>
          <Link to="/community" className={rowClass} onClick={() => {
            const properties = { ...attribution(), destination: '/community', tool: 'Community' };
            posthog.capture('landing_header_tools_item_clicked', properties);
            posthog.capture('landing_header_community_clicked', properties);
            setOpen(false);
          }}><Users aria-hidden="true" className="h-4 w-4 shrink-0" />Community</Link>
        </li>
        <li>
          <a href="https://github.com/for-real-labs/brickbuilder-ai" target="_blank" rel="noopener noreferrer"
            className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]"
            onClick={() => {
              const properties = { ...attribution(), destination: 'https://github.com/for-real-labs/brickbuilder-ai', tool: 'GitHub' };
              posthog.capture('landing_header_tools_item_clicked', properties);
              posthog.capture('landing_header_github_clicked', properties);
              setOpen(false);
            }}>
            <Github aria-hidden="true" className="h-4 w-4 shrink-0" />GitHub
          </a>
        </li>
        <li role="separator" className="my-1 border-t border-slate-200" />
        <li>
          <button type="button" aria-haspopup="dialog" aria-expanded={Boolean(feedbackOpen)}
            className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#f44336]"
            onClick={() => {
              const properties = { ...attribution(), tool: 'Feedback' };
              posthog.capture('landing_header_tools_item_clicked', properties);
              posthog.capture('landing_header_feedback_clicked', properties);
              setFeedbackOpen(true);
              setOpen(false);
            }}>
            <MessageSquare aria-hidden="true" className="h-4 w-4 shrink-0" />Feedback
          </button>
        </li>
        <li>
          <button type="button" aria-haspopup="dialog" aria-expanded={Boolean(supportOpen)} className={rowClass} onClick={() => {
            posthog.capture('landing_header_tools_item_clicked', { ...attribution(), tool: 'Support' });
            setSupportOpen(true);
            setOpen(false);
          }}><LifeBuoy aria-hidden="true" className="h-4 w-4 shrink-0" />Support</button>
        </li>
      </ul>
    </div>}
    {feedbackOpen !== null && <FeedbackWidget open={feedbackOpen} onClose={() => setFeedbackOpen(false)} returnFocusRef={trigger} />}
    {supportOpen !== null && <SupportDialog open={supportOpen} onClose={() => setSupportOpen(false)} generationId={model?.generation.generation_id} returnFocusRef={trigger} />}
  </div>;
});
