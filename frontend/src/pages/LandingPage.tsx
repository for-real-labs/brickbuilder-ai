import { LandingSocialLinks } from "../components/LandingSocialLinks";
import { LandingToolsMenu, type LandingToolsHandle, type GenerationSettingsAction } from '../components/LandingToolsMenu';
import { isBuddyToolIntent } from '../utils/buddyTools';
import { LDrawUploadSection } from '../components/LDrawUploadSection';
import { ImageUploadSection } from '../components/ImageUploadSection';
import { IMAGE_UPLOAD_ACCEPT, prepareImageUpload } from '../utils/prepareImageUpload';
import { IMAGE_LANDING_PAGES, type ImageLandingPath } from '../imageLandingPages';
import { GIFT_PROMPT_SUGGESTION } from '../utils/promptExamples';
import { PetPromptGreeting } from '../components/PetCompanion';
import { usePet, usePetActivity } from '../contexts/PetContext';
import { BuildBuddyDialogue } from '../components/BuildBuddyDialogue';
import { BuildBuddyApi } from '../services/buildBuddyApi';
import { useBuildBuddyChat } from '../hooks/useBuildBuddyChat';
import { buildFailureMessage } from '../utils/buildProgress';
import { useLandingModel, type LandingModel } from '../hooks/useLandingModel';
import { LandingModelWorkspace } from '../components/LandingModelWorkspace';
import { PendingEditActions } from '../components/PendingEditActions';
import { GenerationElapsedTime } from '../components/GenerationElapsedTime';
import { CreateNewBuildsPrompt } from '../components/CreateNewBuildsPrompt';
import { RandomBuildPrompt } from '../components/RandomBuildPrompt';
import { useRecentCompletedBuilds } from '../hooks/useRecentCompletedBuilds';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import { getGeneratedModelPath } from '../utils/generationRoutes';
import { useLandingViewport } from '../hooks/useLandingViewport';
import { useLandingHelp } from '../hooks/useLandingHelp';
import './LandingPage.css';

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Image as ImageIcon, Github, ChevronDown, Sparkles, X } from "lucide-react";
import { SEO } from "../components/SEO";
import FallingBricks from "../components/FallingBricks";
import LoginModal from "../components/LoginModal";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TextToBricksApiService } from "../services/textToBricksApi";
import { ImageToBricksApiService, StreamEvent, PipelineEvent } from "../services/imageToBricksApi";
import { GetGenerationApiService } from "../services/getGenerationApi";
import { recordAnonymousGeneration } from "../utils/anonGenerations";
import { useAuth } from "../contexts/AuthContext";
import { ProfileMenu } from "../components/ProfileMenu";
import { GenerationActivityList } from "../components/GenerationActivityList";
import { useGenerationActivity, isGenerationActive } from "../hooks/useGenerationActivity";
import { LocalProviderSettings } from "../components/LocalProviderSettings";
import { NovaProviderLoginModal, type NovaLoginProvider } from '../components/NovaProviderLoginModal';
import { DEFAULT_NOVA_OPTIONS, NovaToBricksApiService, type NovaBuilderOptions as NovaOptions } from "../services/novaToBricksApi";
import { isLocalDevelopment, LocalProvidersApiService } from "../services/localProvidersApi";
import {
  DEFAULT_LLM_MODEL,
  GENERATION_MODEL_OPTIONS,
  LlmToBricksApiService,
  getLlmModelOption,
} from "../services/llmToBricksApi";
import posthog from "posthog-js";
import { startPolling } from '../utils/polling';
import { useAnimatedGenerationStats } from '../hooks/useAnimatedGenerationStats';
import { GetGenerationStatsApiService, type GenerationStats } from '../services/getGenerationStatsApi';

// Toggle whether users must be logged in before starting a generation.
const REQUIRE_LOGIN_FOR_GENERATION = false;

// LocalStorage keys for persisting generated models
const STORAGE_KEYS = {
  LDR_CONTENT: 'lastLdrContent',
  MPD_CONTENT: 'lastMpdContent',
  MODEL_NAME: 'lastModelName',
  GENERATED_AT: 'lastGeneratedAt',
  GENERATION_ID: 'lastGenerationId'
};

// SessionStorage key for persisting landing form state across login redirects
const PENDING_LANDING_STATE_KEY = 'pendingLandingState';

type SizeValue = "tiny" | "medium" | "big";
const SIZE_PRESETS: { label: string; value: SizeValue }[] = [
  { label: "Tiny", value: "tiny" },
  { label: "Medium", value: "medium" },
  { label: "Big", value: "big" },
];

type ModelQuality = "regular" | "premium";
const MODEL_QUALITY_PRESETS: { label: string; value: ModelQuality; modelOption: string }[] = [
  { label: "Regular", value: "regular", modelOption: "a" },
  { label: "Premium", value: "premium", modelOption: "b" },
];
const DEFAULT_PROMPT_OPTION = "a";

type GenerationMethod = "3d" | "llm" | "nova";
type RandomBuildSuggestion = { status: 'loading' | 'ready' | 'error'; idea: string | null; previousIdeas: string[] };
export const DEFAULT_GENERATION_METHOD: GenerationMethod = "nova";
export type ThreeDModel = "sam3d" | "trellis";
export const DEFAULT_THREE_D_MODEL: ThreeDModel = "sam3d";

export function GenerationModelSelector({
  model = DEFAULT_LLM_MODEL,
  mode = DEFAULT_GENERATION_METHOD,
  disabled = false,
  onChange,
}: {
  model?: string;
  mode?: GenerationMethod;
  disabled?: boolean;
  onChange: (model: string) => void;
}) {
  return (
    <div className="relative min-w-0 w-full sm:w-auto">
      <label htmlFor="landing-render-model" className="sr-only">Model</label>
      <select
        id="landing-render-model"
        value={model}
        disabled={disabled}
        onChange={event => {
          const option = getLlmModelOption(event.target.value);
          const selected = event.target.value;
          if (!option || !GENERATION_MODEL_OPTIONS.some(option => option.id === selected) || selected === model || disabled) return;
          onChange(selected);
          posthog.capture('landing_render_model_selected', {
            generation_method: mode === '3d' ? 'llm' : mode, model: selected, provider: option.provider,
          });
        }}
        className="min-h-11 w-full min-w-0 appearance-none cursor-pointer rounded-full border border-slate-200 bg-white py-2 pl-4 pr-10 text-sm text-slate-700 transition-colors hover:border-red-200 focus:border-[#f44336] focus:outline-none focus:ring-2 focus:ring-red-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-52"
      >
        {GENERATION_MODEL_OPTIONS.map(option => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

export default function LandingPage({ imageLandingPath }: { imageLandingPath?: ImageLandingPath } = {}) {
  const [visit, setVisit] = useState(0);
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setVisit(current => current + 1);
      posthog.capture('landing_visit_reset', { source: 'history_restore' });
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);
  return <LandingPageVisit key={`${imageLandingPath || '/'}:${visit}`} imageLandingPath={imageLandingPath} />;
}

function LandingPageVisit({ imageLandingPath }: { imageLandingPath?: ImageLandingPath }) {
  const { pet } = usePet();
  const ldrawLanding = imageLandingPath === 'use-ai-to-edit-ldraw';
  const imageLanding = imageLandingPath ? IMAGE_LANDING_PAGES[imageLandingPath] : null;
  const landingViewportRef = useLandingViewport(!ldrawLanding);
  const helpVisible = useLandingHelp(landingViewportRef, !ldrawLanding);
  const { session, userProfile, loading: authLoading } = useAuth();
  const buddyChat = useBuildBuddyChat(pet.id, session?.access_token, session?.user.id || 'guest');
  const { generations, error: activityError, trackGeneration, dismissGeneration } = useGenerationActivity(
    session?.user.id || "anonymous", session?.access_token, !authLoading,
  );
  const { active: notificationActive, notifications } = useGenerationNotifications();
  const [createNewStage, setCreateNewStage] = useState<'list' | null>(null);
  const [randomSuggestion, setRandomSuggestion] = useState<RandomBuildSuggestion | null>(null);
  const randomRequestRef = useRef<AbortController | null>(null);
  const [recentBuildPage, setRecentBuildPage] = useState(0);
  const [recentBuildRefresh, setRecentBuildRefresh] = useState(0);
  const completedBuilds = useRecentCompletedBuilds(session?.access_token, session?.user.id, `${recentBuildRefresh}:${notifications.map(row => `${row.id}:${row.status}`).join(',')}`);
  const [prompt, setPrompt] = useState("");
  const [hasEnteredChat, setHasEnteredChat] = useState(false);
  const [giftPlanning, setGiftPlanning] = useState(false);
  const giftReplyPending = buddyChat.turns.some(turn => turn.kind === 'gift' && !turn.reply);
  useEffect(() => {
    randomRequestRef.current?.abort();
    setRandomSuggestion(null);
    setGiftPlanning(false);
    setHasEnteredChat(false);
  }, [session?.user.id]);
  useEffect(() => () => randomRequestRef.current?.abort(), []);
  useEffect(() => {
    if (hasEnteredChat) posthog.capture('build_buddy_contextual_suggestion_shown');
  }, [hasEnteredChat]);
  const [notificationPromptId, setNotificationPromptId] = useState<string | null>(null);
  const [orderBarHeight, setOrderBarHeight] = useState(0);
  const [inputValidationMessage, setInputValidationMessage] = useState<string | null>(null);
  const toolsRef = useRef<LandingToolsHandle>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const settingsReturnFocus = useRef<HTMLButtonElement | null>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toggleSettings = (expanded: boolean) => {
    setSettingsOpen(expanded);
    posthog.capture('landing_generation_settings_toggled', { expanded });
  };
  const dismissSettings = () => {
    toggleSettings(false);
    settingsReturnFocus.current?.focus();
  };
  useEffect(() => { if (settingsOpen) settingsCloseRef.current?.focus(); }, [settingsOpen]);
  const handleSettingsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    dismissSettings();
  };
  const [size, setSize] = useState<SizeValue>("big");
  const [modelQuality, setModelQuality] = useState<ModelQuality>("regular");
  const startWithAllParts = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'all_parts';
  const [generationMethod, setGenerationMethod] = useState<GenerationMethod>(startWithAllParts ? 'nova' : DEFAULT_GENERATION_METHOD);
  const [threeDModel, setThreeDModel] = useState<ThreeDModel>(DEFAULT_THREE_D_MODEL);
  const [llmModel, setLlmModel] = useState<string>(DEFAULT_LLM_MODEL);
  const [novaOptions, setNovaOptions] = useState<NovaOptions>(DEFAULT_NOVA_OPTIONS);
  const localDevelopment = isLocalDevelopment();
  const [providerLogin, setProviderLogin] = useState<NovaLoginProvider | null>(null);
  const [checkingProvider, setCheckingProvider] = useState(false);
  const providerChoices = useRef<Partial<Record<NovaLoginProvider, 'native' | 'api_key'>>>({});
  const checkingProviderRef = useRef(false);

  const checkNovaConnection = async (model: string): Promise<'native' | 'api_key' | null> => {
    if (!localDevelopment) return 'api_key';
    const provider = getLlmModelOption(model)?.provider as NovaLoginProvider | undefined;
    if (!provider || checkingProviderRef.current) return null;
    checkingProviderRef.current = true; setCheckingProvider(true);
    try {
      const status = await LocalProvidersApiService.getProviderStatus(provider);
      const mode = providerChoices.current[provider] === 'api_key' && status.api_key_configured
        ? 'api_key' : status.cli_connected ? 'native' : null;
      if (mode) { setNovaOptions(current => ({ ...current, authMode: mode })); return mode; }
      setProviderLogin(provider);
      return null;
    } catch {
      setProviderLogin(provider);
      return null;
    } finally { checkingProviderRef.current = false; setCheckingProvider(false); }
  };
  const [imgFile, setImgFile] = useState<File | null>(null);
  useEffect(() => {
    if (imgFile) setInputValidationMessage(null);
  }, [imgFile]);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preparingImage, setPreparingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const uploadRevision = useRef(0);

  const [focused, setFocused] = useState(false);
  const submittedOnTouch = useRef(false);
  const keyboardWasVisible = useRef(false);
  useEffect(() => {
    if (!focused) { keyboardWasVisible.current = false; return; }
    const viewport = window.visualViewport;
    const isTouchDevice = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return;
    const keyboardOpen = () => Boolean(viewport && window.innerHeight - viewport.height - viewport.offsetTop > 120);
    const restoreBannerIfKeyboardClosed = () => {
      if (keyboardOpen()) { keyboardWasVisible.current = true; return; }
      if (keyboardWasVisible.current || document.visibilityState === 'visible') promptInputRef.current?.blur();
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') restoreBannerIfKeyboardClosed(); };
    const onViewportResize = () => {
      if (keyboardOpen()) keyboardWasVisible.current = true;
      else if (keyboardWasVisible.current) restoreBannerIfKeyboardClosed();
    };
    viewport?.addEventListener('resize', onViewportResize);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', restoreBannerIfKeyboardClosed);
    return () => {
      viewport?.removeEventListener('resize', onViewportResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', restoreBannerIfKeyboardClosed);
    };
  }, [focused]);

  // NEW: in‑place loading state
  const [loading, setLoading] = useState(false);
  const generationAbortRef = useRef<AbortController | null>(null);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);

  // Generated model state
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedModelId = searchParams.get('id');
  const [linkedModelId] = useState(requestedModelId);
  const landingModel = useLandingModel(session?.user.id || 'guest', session?.access_token, requestedModelId);
  const openModel = useCallback((id: string, retainModel = false) => {
    landingModel.open(id, retainModel);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('id', id);
      next.set('exact', '1');
      next.delete('instructions');
      return next;
    }, { replace: true });
  }, [landingModel.open, setSearchParams]);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const editSubmittingRef = useRef(false);
  const modelBusy = landingModel.busy || editSubmitting;
  const pendingEdit = Boolean(landingModel.model && (editSubmitting || (landingModel.busy
    && landingModel.targetId !== landingModel.model.generation.generation_id)));
  const pendingEditId = pendingEdit && landingModel.targetId !== landingModel.model?.generation.generation_id
    ? landingModel.targetId : null;
  const selectedActiveGeneration = generations.find(row => row.id === landingModel.targetId && isGenerationActive(row.status));
  const pendingGeneration = !createNewStage && !landingModel.model && (loading || Boolean(selectedActiveGeneration)
    || Boolean(activeGenerationId && landingModel.busy));
  const pendingGenerationId = pendingEdit ? pendingEditId
    : pendingGeneration ? selectedActiveGeneration?.id || activeGenerationId : null;
  const processingBuilds = [...generations.filter(row => isGenerationActive(row.status))];
  for (const row of notificationActive || []) {
    if (!generations.some(generation => generation.id === row.id)) processingBuilds.push({
      id: row.id, prompt: row.prompt, status: row.status, createdAt: row.created_at,
    });
  }
  processingBuilds.sort((left, right) => (right.createdAt || '').localeCompare(left.createdAt || ''));
  const visitGenerationIds = new Set(buddyChat.turns.map(turn => turn.generationId));
  const displayedGenerations = generations.filter(row => ldrawLanding || row.id === landingModel.targetId || visitGenerationIds.has(row.id))
    .map(row => row.id === landingModel.model?.generation.generation_id
    ? { ...row, status: 'completed', previewWaitUntil: undefined } : row);
  const [generationError, setGenerationError] = useState<string | null>(null);

  const navigate = useNavigate();
  const [generationStats, setGenerationStats] = useState<GenerationStats | null>(null);
  const displayedGenerationStats = useAnimatedGenerationStats(generationStats);
  useEffect(() => {
    const polling = startPolling(async signal => {
      const stats = await GetGenerationStatsApiService.getGenerationStats(signal);
      if (!signal.aborted) setGenerationStats(stats);
    }, { intervalMs: 30_000 });
    return polling.stop;
  }, []);
  // Login modal state
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [pendingGenerateAfterLogin, setPendingGenerateAfterLogin] = useState(false);

  // Generate preview URL for uploaded image
  useEffect(() => {
    if (imgFile) {
      const url = URL.createObjectURL(imgFile);
      setImagePreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setImagePreviewUrl(null);
    }
  }, [imgFile]);

  // Restore pending form state after returning from a login redirect
  useEffect(() => {
    const raw = sessionStorage.getItem(PENDING_LANDING_STATE_KEY);
    if (!raw) return;
    sessionStorage.removeItem(PENDING_LANDING_STATE_KEY);
    try {
      const payload = JSON.parse(raw) as {
        prompt?: string;
        size?: SizeValue;
        modelQuality?: ModelQuality;
        generationMethod?: string;
        threeDModel?: string;
        llmModel?: string;
        novaOptions?: NovaOptions;
        image?: { name: string; type: string; base64: string } | null;
      };
      if (typeof payload.prompt === 'string') setPrompt(payload.prompt);
      if (payload.size) setSize(payload.size);
      if (payload.modelQuality) setModelQuality(payload.modelQuality);
      setGenerationMethod(startWithAllParts ? 'nova' : payload.generationMethod === 'nova' || payload.generationMethod === 'llm'
        ? payload.generationMethod : DEFAULT_GENERATION_METHOD);
      if (payload.novaOptions && getLlmModelOption(payload.novaOptions.model)) {
        setNovaOptions({ ...DEFAULT_NOVA_OPTIONS, ...payload.novaOptions, model: DEFAULT_LLM_MODEL, authMode: localDevelopment && payload.novaOptions.authMode === 'native' ? 'native' : 'api_key' });
      }
      if (payload.image && payload.image.base64) {
        try {
          const binary = atob(payload.image.base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          const restored = new File([bytes], payload.image.name, { type: payload.image.type });
          setImgFile(restored);
        } catch (decodeErr) {
          console.warn('Failed to restore uploaded image after login:', decodeErr);
        }
      }
    } catch (err) {
      console.warn('Failed to parse pending landing state:', err);
    }
  }, []);

  const onPickImage = (uploadPosition: 'input_left_icon' | 'image_upload_section' | 'buddy_dialogue' = 'image_upload_section') => {
    posthog.capture('landing_image_picker_opened', { page: imageLandingPath ?? '/', upload_position: uploadPosition });
    fileInputRef.current?.click();
  };
  useEffect(() => {
    if (!ldrawLanding) posthog.capture('landing_image_upload_control_shown', {
      page: imageLandingPath ?? '/', upload_position: 'input_left_icon',
    });
  }, [imageLandingPath, ldrawLanding]);
  const selectImage = async (file: File, source: 'picker' | 'drop') => {
    if (settingsOpen) toggleSettings(false);
    const revision = ++uploadRevision.current;
    setPreparingImage(true); setImageUploadError(null);
    try {
      const prepared = await prepareImageUpload(file);
      if (revision !== uploadRevision.current) return;
      setGiftPlanning(false); setImgFile(prepared); setInputValidationMessage(null);
      setHasEnteredChat(true);
      posthog.capture('landing_image_uploaded', { page: imageLandingPath ?? '/', source, format: prepared.type });
    } catch (error) {
      if (revision === uploadRevision.current) setImageUploadError(error instanceof Error ? error.message : 'Unable to read this image. Please try another file.');
    } finally { if (revision === uploadRevision.current) setPreparingImage(false); }
  };
  const clearSelectedImage = () => {
    uploadRevision.current++; setPreparingImage(false); setImageUploadError(null);
    posthog.capture('landing_image_removed', { page: imageLandingPath ?? '/' });
    setImgFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const onFileChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    if (file) void selectImage(file, 'picker');
    e.target.value = '';
  };

  // Drag-and-drop state & handlers
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;
    if (loading || buddyChat.routing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void selectImage(file, 'drop');
  };

  // Helper function to convert File to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // Remove the data URL prefix (e.g., "data:image/png;base64,")
          const base64 = reader.result.split(',')[1];
          resolve(base64);
        } else {
          reject(new Error('Failed to read file as base64'));
        }
      };
      reader.onerror = (error) => reject(error);
    });
  };

  // Persist current form state so it can be restored after a login redirect.
  const savePendingLandingState = async (): Promise<void> => {
    try {
      let imageData: { name: string; type: string; base64: string } | null = null;
      if (imgFile) {
        const base64 = await fileToBase64(imgFile);
        imageData = { name: imgFile.name, type: imgFile.type, base64 };
      }
      const payload = {
        prompt,
        size,
        modelQuality,
        generationMethod,
        threeDModel,
        llmModel,
        novaOptions: { ...novaOptions, model: llmModel },
        image: imageData,
      };
      sessionStorage.setItem(PENDING_LANDING_STATE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn('Failed to persist landing state before login redirect:', err);
    }
  };

  const onGenerate = async (requestedPrompt = prompt, requestedImage = imgFile, existingTurnId?: number) => {
    // Prevent multiple simultaneous calls
    if (loading || preparingImage || checkingProviderRef.current || providerLogin) return;

    if (imageLanding && !requestedImage && !requestedPrompt.trim()) {
      setImageUploadError('Upload an image to get started. You can add optional instructions below.');
      posthog.capture('landing_generation_image_required', { page: imageLandingPath });
      return;
    }

    // Validate input: either text prompt or image required
    if (!requestedImage && !requestedPrompt.trim()) {
      setGenerationError(null);
      setInputValidationMessage("Describe what you’d like to build, or upload an image to get started.");
      promptInputRef.current?.focus();
      posthog.capture("landing_generation_input_required");
      return;
    }

    setInputValidationMessage(null);

    let novaAuthMode = novaOptions.authMode;
    if (generationMethod === 'nova' && localDevelopment) {
      const mode = await checkNovaConnection(llmModel);
      if (!mode) return;
      novaAuthMode = mode;
    }

    if (REQUIRE_LOGIN_FOR_GENERATION && authLoading) {
      return;
    }

    if (REQUIRE_LOGIN_FOR_GENERATION && !session) {
      setShowLoginModal(true);
      setPendingGenerateAfterLogin(true);
      return;
    }

    // Clear previous results and errors
    setGenerationError(null);
    
    // Clear old recently prompted generation ID before starting new one
    localStorage.removeItem('recently_prompted_generation_id');
    
    // Start loading
    setCreateNewStage(null);
    setLoading(true);
    const controller = new AbortController();
    generationAbortRef.current = controller;
    setActiveGenerationId(null);
    const generationStartedAt = new Date().toISOString();
    const submittedPrompt = requestedPrompt.trim();
    const turnId = existingTurnId ?? buddyChat.startTurn(submittedPrompt, requestedImage);
    
    try {
      const imageBase64 = requestedImage ? await fileToBase64(requestedImage) : undefined;
      buddyChat.requestReply(turnId, submittedPrompt, imageBase64, requestedImage?.type);
      // Convert size to voxelSize (similar to BrickBuilder component)
      // scale conversion from: https://chatgpt.com/share/690f88ae-7234-8006-bca8-a56e991721fb
      const getVoxelSize = (size: SizeValue): number => {
        switch (size) {
          case 'tiny': return Math.round((40 + 199) / 18.333);
          case 'medium': return Math.round((125 + 199) / 18.333);
          case 'big': return 40;
          default: return Math.round((125 + 199) / 18.333);
        }
      };
      
      let postResponse;
      let modelName: string;
      
      // Get modelOption based on quality selection
      const modelOption = MODEL_QUALITY_PRESETS.find(q => q.value === modelQuality)?.modelOption || 'b';
      
      const promptOption = DEFAULT_PROMPT_OPTION;
      
      // Get auth token if user is logged in
      const authToken = session?.access_token;
      
      // The viewer owns progress visuals. The stream only supplies the active build ID.
      const handleStreamEvent = (event: StreamEvent) => {
        if (controller.signal.aborted || !('type' in event) || event.type !== 'pipeline') return;
        const pipeline = event as PipelineEvent;
        if (pipeline.generation_id) {
          setActiveGenerationId(pipeline.generation_id);
          clearSelectedImage();
        }
      };

      // Image generation always streams via the SSE endpoint. The 3D model
      // only decides how the 3D step runs: SAM3D (streamed live voxels) or
      // Trellis (non-streamed).
      const stream3d = threeDModel === 'sam3d';

      if (generationMethod === 'nova') {
        postResponse = await NovaToBricksApiService.generate({
          ...novaOptions,
          model: llmModel,
          authMode: localDevelopment ? novaAuthMode : 'api_key',
          prompt: requestedPrompt.trim() || undefined,
          imageBase64,
          imageMediaType: requestedImage?.type || 'image/png',
          detailLevel: getVoxelSize(size),
        }, authToken);
        modelName = requestedPrompt.trim() || requestedImage?.name.replace(/\.[^/.]+$/, '') || 'full-set-model';
      } else if (generationMethod === 'llm') {
        postResponse = await LlmToBricksApiService.generate(
          {
            prompt: requestedPrompt.trim() || undefined,
            imageBase64,
            imageMediaType: requestedImage?.type || 'image/png',
            detailLevel: getVoxelSize(size),
            model: llmModel,
          },
          authToken,
        );
        modelName = requestedPrompt.trim() || requestedImage?.name.replace(/\.[^/.]+$/, '') || 'llm-model';
      } else if (requestedImage) {
        console.log(`Generating from image (3D model: ${threeDModel}):`, requestedImage.name);
        const imageBase64 = await fileToBase64(requestedImage);
        postResponse = await ImageToBricksApiService.generateBricksFromImageStream(
          imageBase64,
          getVoxelSize(size),
          authToken,
          modelOption,
          promptOption,
          handleStreamEvent,
          stream3d,
          'trimesh',
          requestedPrompt.trim(),
          controller.signal,
        );
        modelName = requestedPrompt.trim() || requestedImage.name.replace(/\.[^/.]+$/, ''); // Remove file extension
      } else {
        console.log(`Generating from text prompt (3D model: ${threeDModel}):`, requestedPrompt.trim());
        postResponse = await TextToBricksApiService.generateBricksFromTextStream(
          requestedPrompt.trim(),
          getVoxelSize(size),
          authToken,
          modelOption,
          promptOption,
          handleStreamEvent,
          stream3d,
          'trimesh',
          controller.signal,
        );
        modelName = requestedPrompt.trim();
      }
      
      if (controller.signal.aborted) return;
      const generationId = postResponse.generation_id;
      buddyChat.updateTurn(turnId, { generationId, method: generationMethod });
      setPrompt('');
      posthog.capture('generation_started', { generation_id: generationId, page: window.location.pathname,
        input_type: requestedImage ? 'image' : 'text', generation_method: generationMethod });
      clearSelectedImage();
      setActiveGenerationId(generationId);
      console.log('Generation started, polling for status:', generationId);
      
      // Save generation ID immediately so page reload can resume polling
      localStorage.setItem(STORAGE_KEYS.GENERATION_ID, generationId);
      // Save as recently prompted generation for priority checking on page load
      localStorage.setItem('recently_prompted_generation_id', generationId);
      // If created while logged out, remember it so it can be claimed on login.
      if (!session) recordAnonymousGeneration(generationId);
      
      if (generationMethod === 'llm' || generationMethod === 'nova') {
        openModel(generationId);
        trackGeneration({ id: generationId, prompt: modelName, status: 'started', endpoint: generationMethod === 'nova' ? 'novaToBricks' : 'llmToBricks', createdAt: generationStartedAt });
        setNotificationPromptId(generationId);
        setCreateNewStage(null);
        setLoading(false);
        return;
      }

      const completedGeneration = await GetGenerationApiService.pollUntilComplete(
        generationId, () => {}, 2500, 120, controller.signal
      );

      console.log('Generation completed:', completedGeneration.generation_id);
      
      if (controller.signal.aborted) return;
      setLoading(false);
      openModel(completedGeneration.generation_id);
      if (!session) recordAnonymousGeneration(completedGeneration.generation_id);
      
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setLoading(false);
        setActiveGenerationId(null);
        localStorage.removeItem('recently_prompted_generation_id');
        return;
      }
      console.error('Generation failed:', error);
      const message = buildFailureMessage(error);
      setGenerationError(message);
      buddyChat.updateTurn(turnId, { error: message, reply: undefined });
      setLoading(false);
      // Clear the recently prompted ID on failure
      localStorage.removeItem('recently_prompted_generation_id');
    }
  };

  const submitModelEdit = async (existingTurnId?: number, requestedPrompt = prompt, requestedImage = imgFile) => {
    const model = landingModel.model;
    if (!model || modelBusy || preparingImage || editSubmittingRef.current || !requestedPrompt.trim()) return;
    editSubmittingRef.current = true;
    setCreateNewStage(null);
    setEditSubmitting(true);
    setGenerationError(null);
    const submittedPrompt = requestedPrompt.trim();
    const sourceId = model.generation.generation_id;
    const turnId = existingTurnId ?? buddyChat.startTurn(submittedPrompt, null);
    buddyChat.requestReply(turnId, submittedPrompt);
    posthog.capture('landing_model_ai_edit_submitted', { generation_id: sourceId, prompt_length: submittedPrompt.length, has_image: Boolean(requestedImage) });
    try {
      const image = requestedImage ? { imageBase64: await fileToBase64(requestedImage), imageMediaType: requestedImage.type } : undefined;
      const nova = model.generation.endpoint === 'novaToBricks' || model.generation.endpoint === 'uploadLdraw';
      const response = nova
        ? await NovaToBricksApiService.edit(sourceId, submittedPrompt, session?.access_token, image)
        : await LlmToBricksApiService.generate({ sourceGenerationId: sourceId, prompt: submittedPrompt, ...image }, session?.access_token);
      const id = response.generation_id;
      localStorage.setItem(STORAGE_KEYS.GENERATION_ID, id);
      if (!session) recordAnonymousGeneration(id);
      buddyChat.updateTurn(turnId, { generationId: id, method: nova ? 'nova' : 'llm' });
      trackGeneration({ id, prompt: submittedPrompt, status: 'started', endpoint: nova ? 'novaToBricks' : 'llmToBricks', createdAt: new Date().toISOString() });
      openModel(id, true);
      setImgFile(null);
      setNotificationPromptId(id);
      setCreateNewStage(null);
      setPrompt('');
    } catch (error) {
      console.error('Model edit failed:', error);
      const message = buildFailureMessage(error);
      setGenerationError(message);
      buddyChat.updateTurn(turnId, { error: message, reply: undefined });
      posthog.capture('landing_model_ai_edit_failed', { generation_id: sourceId });
    } finally {
      editSubmittingRef.current = false;
      setEditSubmitting(false);
    }
  };

  const resetWorkspace = () => {
    landingModel.reset();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.delete('id');
      next.delete('exact');
      next.delete('instructions');
      return next;
    }, { replace: true });
    setGiftPlanning(false);
    setPrompt('');
    setGenerationError(null);
    setInputValidationMessage(null);
    clearSelectedImage();
  };
  const createNewModel = () => {
    posthog.capture('landing_model_create_new_clicked', { generation_id: landingModel.model?.generation.generation_id });
    resetWorkspace();
    buddyChat.resetConversation();
    setHasEnteredChat(false);
    setRecentBuildPage(0);
    setRecentBuildRefresh(current => current + 1);
    randomRequestRef.current?.abort();
    setRandomSuggestion(null);
    setCreateNewStage(null);
  };

  const submitGeneration = (requestedPrompt = prompt, requestedImage = imgFile, existingTurnId?: number) => {
    if (loading) return;
    posthog.capture('landing_generate_clicked', {
      page: window.location.pathname,
      input_type: requestedImage ? 'image' : 'text',
      generation_method: generationMethod,
      model: generationMethod === '3d' ? threeDModel : llmModel,
      has_prompt: Boolean(requestedPrompt.trim()),
      has_image: Boolean(requestedImage),
      size,
      is_authenticated: Boolean(session),
    });
    void onGenerate(requestedPrompt, requestedImage, existingTurnId);
  };
  const requestRandomIdea = (previousIdeas: string[] = []) => {
    randomRequestRef.current?.abort();
    const controller = new AbortController();
    randomRequestRef.current = controller;
    setRandomSuggestion({ status: 'loading', idea: null, previousIdeas });
    posthog.capture('landing_random_build_requested', { source: previousIdeas.length ? 'something_else' : 'initial' });
    void BuildBuddyApi.randomIdea(previousIdeas, session?.access_token, controller.signal)
      .then(idea => {
        if (controller.signal.aborted) return;
        setRandomSuggestion({ status: 'ready', idea, previousIdeas: [...previousIdeas, idea].slice(-8) });
        posthog.capture('landing_random_build_suggested', { prompt: idea });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setRandomSuggestion({ status: 'error', idea: null, previousIdeas });
        posthog.capture('landing_random_build_failed');
      });
  };
  const dismissRandomIdea = () => {
    randomRequestRef.current?.abort();
    setRandomSuggestion(null);
  };
  const buildSomethingRandom = () => requestRandomIdea();
  const tryAnotherRandomIdea = () => requestRandomIdea(randomSuggestion?.previousIdeas || []);
  const buildSuggestedIdea = () => {
    if (randomSuggestion?.status !== 'ready' || !randomSuggestion.idea) return;
    const idea = randomSuggestion.idea;
    posthog.capture('landing_random_build_clicked', { prompt: idea });
    setHasEnteredChat(true);
    dismissRandomIdea();
    setCreateNewStage(null);
    submitGeneration(idea, null);
  };
  const showBuilds = () => {
    posthog.capture('landing_builds_opened', { surface: 'pet_dialogue', processing_count: processingBuilds.length, completed_count: completedBuilds.length });
    dismissRandomIdea();
    setRecentBuildPage(0);
    setRecentBuildRefresh(current => current + 1);
    setCreateNewStage('list');
  };
  const showCommunityModels = () => {
    posthog.capture('landing_community_models_clicked', { surface: 'pet_dialogue' });
    navigate('/community');
  };
  const returnToWelcome = () => {
    posthog.capture('landing_chat_back_clicked', { surface: 'pet_dialogue' });
    buddyChat.resetConversation();
    setHasEnteredChat(false);
    setGiftPlanning(false);
    setPrompt('');
    setInputValidationMessage(null);
    clearSelectedImage();
  };

  const startGiftPlanning = (message: string, id: number) => {
    setGiftPlanning(true);
    setPrompt('');
    clearSelectedImage();
    setInputValidationMessage(null);
    buddyChat.updateTurn(id, { kind: 'gift' });
    void buddyChat.requestGiftReply(id, message, true);
    promptInputRef.current?.focus();
  };

  const sendGiftMessage = (message: string, id: number) => {
    if (giftReplyPending || !message) return;
    buddyChat.updateTurn(id, { kind: 'gift' });
    setPrompt('');
    void buddyChat.requestGiftReply(id, message);
  };

  const suggestImageUpload = (id: number) => {
    setGiftPlanning(false);
    setPrompt('');
    const desktop = window.matchMedia?.('(min-width: 768px) and (hover: hover) and (pointer: fine)').matches ?? false;
    buddyChat.updateTurn(id, { kind: 'upload', reply: desktop
      ? 'Drop a picture here, or click Upload image below.'
      : 'Tap Upload image below to pick a picture.' });
  };

  const handleUserMessage = async () => {
    if (buddyChat.routing || loading || preparingImage || (landingModel.model && modelBusy) || giftReplyPending) return;
    if (!prompt.trim() && !imgFile) {
      if (!landingModel.model) submitGeneration();
      return;
    }
    const text = prompt.trim();
    const image = imgFile;
    setHasEnteredChat(true);
    const result = await buddyChat.routeMessage(text, image,
      landingModel.model ? landingModel.model.generation.name || landingModel.model.generation.prompt || 'Current model' : undefined,
      giftPlanning);
    if (!result) return;
    if (isBuddyToolIntent(result.intent)) {
      setPrompt('');
      setGiftPlanning(false);
      const reply = toolsRef.current?.runTool(result.intent, landingModel.model?.generation.generation_id)
        || 'I couldn’t open that tool. Try the Tools menu.';
      buddyChat.updateTurn(result.id, { reply });
    } else if (result.intent === 'generate') {
      setGiftPlanning(false);
      if (landingModel.model) void submitModelEdit(result.id, text, image);
      else submitGeneration(text, image, result.id);
    } else if (result.intent === 'upload') {
      posthog.capture('build_buddy_suggestion_submitted', { suggestion: 'upload' });
      suggestImageUpload(result.id);
    } else if (result.intent === 'gift') {
      if (giftPlanning && text.toLowerCase().replace(/[.!?]+$/, '') !== GIFT_PROMPT_SUGGESTION.toLowerCase()) {
        sendGiftMessage(text, result.id);
      } else {
        posthog.capture('build_buddy_suggestion_submitted', { suggestion: 'gift' });
        startGiftPlanning(text, result.id);
      }
    } else {
      setPrompt('');
      try {
        const imageBase64 = image ? await fileToBase64(image) : undefined;
        buddyChat.requestReply(result.id, text, imageBase64, image?.type, result.intent);
      } catch {
        buddyChat.updateTurn(result.id, { reply: 'I couldn’t read that image. Please choose it again.' });
      }
    }
  };

  // After a successful login from the modal, automatically continue generation
  useEffect(() => {
    if (pendingGenerateAfterLogin && session && !authLoading && !loading) {
      setPendingGenerateAfterLogin(false);
      onGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGenerateAfterLogin, session, authLoading]);

  const petState = usePetActivity(loading || modelBusy || displayedGenerations.some(row => isGenerationActive(row.status)), Boolean(landingModel.model), Boolean(generationError || landingModel.error));

  const sendLabel = buddyChat.routing ? 'Sending…' : landingModel.model ? modelBusy ? 'Editing…' : 'Apply edit' : giftPlanning ? 'Send' : 'Create';
  const latestChatTurn = buddyChat.turns.at(-1);
  const canReturnToWelcome = Boolean(latestChatTurn?.reply || latestChatTurn?.error)
    && !buddyChat.turns.some(turn => turn.generationId)
    && !landingModel.model && !pendingGeneration && !pendingEdit && !loading && !buddyChat.routing
    && !createNewStage && !randomSuggestion;
  const conversationStarted = !ldrawLanding
    && (hasEnteredChat || buddyChat.turns.length > 0 || Boolean(requestedModelId) || Boolean(landingModel.model) || Boolean(createNewStage));

  const generationActivity = (
    <GenerationActivityList generations={landingModel.model ? displayedGenerations.filter(row => row.status !== 'completed') : displayedGenerations} error={displayedGenerations.length || ldrawLanding ? activityError : null} onDismiss={dismissGeneration} buddyDialogue={!ldrawLanding}
      notificationPromptId={notificationPromptId} onNotificationPromptShown={() => setNotificationPromptId(null)}
      onOpen={id => { openModel(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
      onResumed={(sourceId, newId) => {
        const row = generations.find(generation => generation.id === sourceId);
        if (row) trackGeneration({ ...row, id: newId, status: 'started', errorMessage: undefined,
          createdAt: new Date().toISOString(), durationSeconds: undefined, previewWaitUntil: undefined }, sourceId);
        if (row) { setNotificationPromptId(newId); openModel(newId); }
      }}
      onCancelled={id => {
        const row = generations.find(generation => generation.id === id);
        if (row) trackGeneration({ ...row, status: 'cancelled', previewWaitUntil: undefined });
      }} />
  );

  return (
    <div
      ref={landingViewportRef}
      className={ldrawLanding ? "min-h-screen overflow-x-hidden text-slate-900 relative" : `landing-page text-slate-900${conversationStarted ? ' landing-page--conversation-started' : ''}${helpVisible ? ' landing-page--help-visible' : ''}`}
      style={{ backgroundColor: "#fbfbfd", '--landing-order-banner-height': `${orderBarHeight}px` } as React.CSSProperties}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag-and-drop overlay */}
      {isDragging && (
        <div
          className="fixed inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          style={{ zIndex: 9999, pointerEvents: 'none' }}
        >
          <div className="rounded-2xl border-4 border-dashed border-white bg-white/20 px-12 py-10 text-center">
            <ImageIcon className="mx-auto mb-3 h-12 w-12 text-white" />
            <p className="text-xl font-semibold text-white">Drop image to upload</p>
          </div>
        </div>
      )}
      <SEO
        title={imageLanding?.title ?? "BrickBuilder - Turn Images into 3D LEGO-Compatible Brick Models"}
        description={imageLanding?.description ?? "Create brick models and building instructions from a photo or a prompt."}
        keywords={imageLanding?.keywords}
        url={`https://brickbuilder.ai/${imageLandingPath ?? ""}`}
      />

      <FallingBricks density={22} opacity={0.25} zIndex={0} />

      <LoginModal
        open={showLoginModal}
        onClose={() => {
          setShowLoginModal(false);
          setPendingGenerateAfterLogin(false);
        }}
        onSuccess={() => setShowLoginModal(false)}
        redirectTo={imageLandingPath ? `/${imageLandingPath}` : "/"}
        onBeforeOAuthRedirect={savePendingLandingState}
      />
      <NovaProviderLoginModal provider={providerLogin} onClose={() => setProviderLogin(null)} onConnected={mode => {
        if (providerLogin) providerChoices.current[providerLogin] = mode;
        setNovaOptions(current => ({ ...current, authMode: mode }));
        setProviderLogin(null);
      }} />

      <div className={`mx-auto flex w-full max-w-screen-xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pt-6 relative ${ldrawLanding ? 'min-h-screen pb-8' : 'landing-page-shell'}`} style={{ zIndex: 10 }}>
        <LandingHeader toolsRef={toolsRef} model={landingModel.model} modelBusy={modelBusy} createNew={(requestedModelId || landingModel.model) && (!landingModel.model || pendingEdit) ? { onClick: createNewModel, disabled: editSubmitting || buddyChat.routing } : undefined} page={`/${imageLandingPath ?? ''}`} onLoginClick={() => setShowLoginModal(true)}
          generationSettings={ldrawLanding ? undefined : {
            open: settingsOpen,
            controls: localDevelopment ? 'landing-generation-settings landing-local-provider-settings' : 'landing-generation-settings',
            onOpen: trigger => { settingsReturnFocus.current = trigger; toggleSettings(true); },
          }} />

        <main className={`flex flex-1 flex-col items-center text-center w-full ${ldrawLanding ? '' : 'landing-page-main'}`}>
          {ldrawLanding ? <h1 className="sr-only">{imageLanding?.uploadTitle || 'Build a custom brick model with BrickBuilder'}</h1>
            : <div className={`landing-page-intro${conversationStarted ? ' landing-page-intro--hidden' : ''}`} aria-hidden={conversationStarted}>
              <div className="landing-page-intro-content">
                <h1 className="text-4xl font-extrabold leading-tight text-slate-900 landing-fade-in landing-delay-2 sm:text-5xl">Imagine. Create. Build.</h1>
                <div className="flex items-center justify-center gap-4 text-slate-600 landing-fade-in landing-delay-2 sm:gap-8" aria-label="BrickBuilder generation statistics">
                  <div className="min-w-0"><span className="block text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{displayedGenerationStats ? displayedGenerationStats.generation_count.toLocaleString() : '—'}</span><span className="whitespace-nowrap text-xs sm:text-sm">models generated</span></div>
                  <div className="h-10 w-px bg-slate-200" aria-hidden="true" />
                  <div className="min-w-0"><span className="block text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{displayedGenerationStats ? displayedGenerationStats.brick_count.toLocaleString() : '—'}</span><span className="whitespace-nowrap text-xs sm:text-sm">bricks generated</span></div>
                </div>
              </div>
            </div>}
          <div className={ldrawLanding ? 'w-full' : 'landing-page-content'}>
          <div className={`mx-auto flex w-full flex-col items-center gap-6 ${landingModel.model ? 'max-w-6xl' : 'max-w-3xl'}`}>
            {ldrawLanding && <div className="w-full landing-fade-in landing-delay-3">
              <PetPromptGreeting mode="upload" state={petState} showPetSwitch={false} />
              <h2 className="mb-1 text-left text-xl font-semibold text-slate-900">{imageLanding?.uploadTitle}</h2>
              <p className="mb-4 text-left text-sm text-slate-600">{imageLanding?.uploadDescription}</p>
              <LDrawUploadSection format={searchParams.get('format') === 'io' ? 'io' : searchParams.get('format') === 'ldraw' ? 'ldraw' : undefined} authToken={session?.access_token} onImported={id => {
                localStorage.setItem('lastGenerationId', id);
                if (!session) recordAnonymousGeneration(id);
                navigate(getGeneratedModelPath(id, true));
              }} />
            </div>}
            {!ldrawLanding && <div className="landing-model-host relative z-20 w-full">
              <LandingModelWorkspace model={landingModel.model} busy={modelBusy || buddyChat.routing} pendingEdit={pendingEdit} building={pendingGeneration} composerFocused={focused}
                requestedInstructionsId={searchParams.get('instructions') === '1' ? requestedModelId : null}
                onCreateNew={createNewModel} createNewDisabled={editSubmitting || buddyChat.routing}
                canRename={Boolean(session?.access_token)} accessToken={session?.access_token}
                onRenameRequest={!session ? () => setShowLoginModal(true) : undefined} onNameSaved={landingModel.rename}
                onOrderBarHeightChange={setOrderBarHeight}>
              <BuildBuddyDialogue turns={buddyChat.turns} generations={displayedGenerations} errorMessage={generationError}
                selectedGenerationId={requestedModelId || landingModel.targetId}
                model={landingModel.model ? { id: landingModel.model.generation.generation_id,
                  orderable: landingModel.model.generation.orderable !== false && landingModel.model.generation.endpoint !== 'uploadLdraw' } : null}
                reasoningOnly={pendingEdit} currentOnly showGenerationElapsedTime={!pendingEdit && !pendingGeneration} showOpeningMessage={Boolean(linkedModelId && requestedModelId === linkedModelId && !landingModel.model && !pendingGeneration)}
                landingWelcome showBuildsScrollHint={Boolean(createNewStage && !landingModel.model && !randomSuggestion)}
                currentMessage={randomSuggestion && !landingModel.model ? <RandomBuildPrompt suggestion={randomSuggestion}
                  onYes={buildSuggestedIdea} onElse={tryAnotherRandomIdea} onBack={() => {
                    posthog.capture('landing_random_build_back_clicked');
                    dismissRandomIdea();
                  }} /> : createNewStage && !landingModel.model ? <CreateNewBuildsPrompt
                  processing={processingBuilds} completed={completedBuilds} page={recentBuildPage} pageSize={5}
                  onBack={() => { posthog.capture('landing_builds_back_clicked', { surface: 'pet_dialogue' }); setCreateNewStage(null); }}
                  onMore={() => setRecentBuildPage(current => current + 1)}
                  onCancelled={id => {
                    const row = processingBuilds.find(generation => generation.id === id);
                    if (row) trackGeneration({ ...row, status: 'cancelled', previewWaitUntil: undefined });
                  }}
                  onView={id => { setCreateNewStage(null); openModel(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }} /> : undefined}
                welcomeActions={<div className="pet-chat-actions">
                  {processingBuilds.length > 0 && <div className="w-full text-left text-xs text-slate-500" aria-label="Builds in progress">
                    {processingBuilds.map((row, index) => <div key={row.id} className="min-w-0 break-words">
                      <span>{processingBuilds.length > 1 ? `Build ${index + 1} in progress` : 'Build in progress'}</span>
                      <GenerationElapsedTime startedAt={row.createdAt} />
                    </div>)}
                  </div>}
                  <button type="button" className="pet-chat-action" onClick={buildSomethingRandom}>Build something random</button>
                  <button type="button" className="pet-chat-action" onClick={showBuilds}>Show builds</button>
                  <button type="button" className="pet-chat-action" onClick={showCommunityModels}>Show me community models</button>
                </div>}
                onBackToWelcome={canReturnToWelcome ? returnToWelcome : undefined}
                onViewGeneration={id => { openModel(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                state={(focused && !loading && !modelBusy) || buddyChat.routing ? 'listening' : petState} authLoading={authLoading}
                username={session ? userProfile?.username || session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.user_metadata?.username : null}>
              </BuildBuddyDialogue>
            {(pendingEdit || pendingGeneration) ? <PendingEditActions key={pendingGenerationId || 'starting'} generationId={pendingGenerationId}
              startedAt={generations.find(generation => generation.id === pendingGenerationId)?.createdAt} isEdit={pendingEdit}
              onCancelled={() => {
                const row = generations.find(generation => generation.id === pendingGenerationId);
                if (row) trackGeneration({ ...row, status: 'cancelled', previewWaitUntil: undefined });
                setNotificationPromptId(null);
                if (pendingEdit && landingModel.model) openModel(landingModel.model.generation.generation_id, true);
                else { generationAbortRef.current?.abort(); resetWorkspace(); setLoading(false); setActiveGenerationId(null); setCreateNewStage(null); }
              }}
              onStartNew={createNewModel} /> : null}
            {!pendingEdit && !pendingGeneration && !randomSuggestion && createNewStage !== 'list' ? <form
              aria-label={landingModel.model ? "Edit your brick model" : "Create a brick model"}
              className="w-full"
              onSubmit={event => {
                event.preventDefault();
                if (settingsOpen) toggleSettings(false);
                void handleUserMessage();
              }}
            >
              {imageLanding && !landingModel.model && <>
                <h2 className="mb-1 text-left text-xl font-semibold text-slate-900">{imageLanding.uploadTitle}</h2>
                <p className="mb-4 text-left text-sm text-slate-600">{imageLanding.uploadDescription}</p>
                <ImageUploadSection previewUrl={imagePreviewUrl} fileName={imgFile?.name} busy={loading || buddyChat.routing || preparingImage}
                  error={imageUploadError} onPick={() => onPickImage('image_upload_section')} onRemove={clearSelectedImage} />
              </>}
              <div className="flex w-full items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <button type="button" aria-label="Upload image" title="Upload image"
                    disabled={loading || buddyChat.routing || preparingImage || modelBusy} onClick={() => { setGiftPlanning(false); onPickImage('input_left_icon'); }}
                    className="absolute left-2 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50">
                    <ImageIcon aria-hidden="true" className="h-5 w-5" />
                  </button>
                  <input
                    id="landing-build-prompt"
                    ref={promptInputRef}
                    aria-label={landingModel.model ? "Describe changes to your model" : "Describe your model"}
                    maxLength={2000}
                    aria-describedby={inputValidationMessage ? "generation-input-help" : undefined}
                    value={prompt}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      setPrompt(event.target.value);
                      if (event.target.value.trim()) setHasEnteredChat(true);
                      if (settingsOpen) toggleSettings(false);
                      if (event.target.value.trim()) setInputValidationMessage(null);
                    }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                      event.currentTarget.form?.requestSubmit();
                    }}
                    placeholder={landingModel.model && imgFile ? "Describe changes using this image" : imgFile || imageLanding ? "Add optional image instructions" : ""}
                    className={`pet-conversation-input h-16 w-full rounded-2xl border border-gray-200 bg-white pl-14 pr-16 text-base shadow-sm transition-colors focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50`}
                    disabled={loading || buddyChat.routing || preparingImage || (Boolean(landingModel.model) && modelBusy)}
                  />
                  {!imageLanding && !imgFile && !prompt && !focused && !loading && !buddyChat.routing &&
                    <span className={`landing-empty-input-hint`} aria-hidden="true">{landingModel.model ? 'edit model' : 'build anything'}<span className="landing-empty-input-caret" /></span>}
                  <button
                    type="submit" aria-label={sendLabel} title={sendLabel}
                    onPointerDown={event => {
                      if (event.pointerType !== 'touch' || !landingModel.model) { submittedOnTouch.current = false; return; }
                      event.preventDefault();
                      submittedOnTouch.current = true;
                      event.currentTarget.form?.requestSubmit();
                    }}
                    onClick={event => {
                      if (submittedOnTouch.current && event.detail > 0) event.preventDefault();
                      submittedOnTouch.current = false;
                    }}
                    disabled={loading || buddyChat.routing || preparingImage || giftReplyPending || (Boolean(landingModel.model) && modelBusy)}
                    className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-[#f44336] text-white transition-colors hover:bg-[#ff6b6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowUp aria-hidden="true" className="h-5 w-5" />
                  </button>
                </div>
              </div>

              {inputValidationMessage && (
                <p id="generation-input-help" role="status" className="mt-3 text-center text-sm leading-6 text-slate-600">
                  {inputValidationMessage}
                </p>
              )}
              <div id="landing-generation-settings" hidden={!settingsOpen}
                onKeyDown={handleSettingsKeyDown} className="mt-3 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm">
                <div className="-ml-2 -mt-2 mb-3 flex items-center gap-1">
                  <button ref={settingsCloseRef} type="button" aria-label="Dismiss generation settings" onClick={dismissSettings}
                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">
                    <X size={18} aria-hidden="true" />
                  </button>
                  <h3 className="text-sm font-semibold text-slate-900">Generation settings</h3>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-left sm:gap-3">
                  <div id="landing-builder-mode" role="group" aria-label="Mode"
                    className="flex min-h-11 w-full shrink-0 items-center rounded-full border border-slate-200 bg-slate-100 p-1 sm:w-auto">
                    {([{ value: 'llm', label: 'Basic bricks' }, { value: 'nova', label: 'All parts' }] as const).map(({ value, label }) => (
                      <button key={value} type="button" value={value}
                        aria-pressed={(generationMethod === '3d' ? 'llm' : generationMethod) === value}
                        disabled={(Boolean(landingModel.model) && modelBusy) || loading || buddyChat.routing || checkingProvider || generationMethod === '3d'}
                        onClick={() => {
                          if (value === generationMethod) return;
                          setGenerationMethod(value);
                          if (localDevelopment && value === 'nova') void checkNovaConnection(llmModel);
                          posthog.capture('landing_generation_method_selected', { generation_method: value });
                        }}
                        className={`min-h-9 flex-1 whitespace-nowrap rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200 disabled:cursor-not-allowed disabled:opacity-50 ${(generationMethod === '3d' ? 'llm' : generationMethod) === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <GenerationModelSelector model={generationMethod === '3d' ? threeDModel : llmModel} mode={generationMethod} onChange={model => {
                    if (model === 'sam3d' || model === 'trellis') {
                      setThreeDModel(model);
                      setGenerationMethod('3d');
                    } else {
                      setLlmModel(model);
                      if (generationMethod === '3d') setGenerationMethod('llm');
                      if (localDevelopment && generationMethod === 'nova') void checkNovaConnection(model);
                    }
                  }} disabled={(Boolean(landingModel.model) && modelBusy) || loading || buddyChat.routing || checkingProvider} />
                </div>
                {localDevelopment && generationMethod === 'nova' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-left text-sm text-slate-600">
                    <label htmlFor="nova-connection">Provider connection</label>
                    <select id="nova-connection" value={novaOptions.authMode} disabled={(Boolean(landingModel.model) && modelBusy) || loading || buddyChat.routing || checkingProvider} className="min-h-11 min-w-0 max-w-full rounded-full border border-slate-200 bg-white px-3" onChange={event => {
                      const provider = getLlmModelOption(llmModel)?.provider as NovaLoginProvider;
                      if (event.target.value === 'native') { delete providerChoices.current[provider]; void checkNovaConnection(llmModel); }
                      else { providerChoices.current[provider] = 'api_key'; setNovaOptions(current => ({ ...current, authMode: 'api_key' })); }
                    }}>
                      <option value="api_key">Project API key</option>
                      <option value="native">{getLlmModelOption(llmModel)?.provider === 'openai' ? 'Signed in to ChatGPT' : 'Signed in to Claude'} · local account</option>
                    </select>
                  </div>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept={IMAGE_UPLOAD_ACCEPT} className="hidden" onChange={onFileChange} disabled={loading || buddyChat.routing || preparingImage || (Boolean(landingModel.model) && modelBusy)} />
              {checkingProvider && <p role="status" className="mt-2 text-left text-sm text-slate-500">Checking provider connection…</p>}
            </form> : null}
              {landingModel.error && <p role="alert" className="mt-3 text-left text-sm text-red-600">{landingModel.error}</p>}
              {!ldrawLanding && localDevelopment && !loading && !pendingEdit && !pendingGeneration && <div id="landing-local-provider-settings" hidden={!settingsOpen} onKeyDown={handleSettingsKeyDown} className="w-full">
                <LocalProviderSettings />
              </div>}

              {(!imageLanding || landingModel.model) && imageUploadError && <p role="alert" className="text-sm text-red-600">{imageUploadError}</p>}
              {(!imageLanding || landingModel.model) && preparingImage && <p role="status" className="text-sm text-slate-500">Preparing your image…</p>}
              {/* Image thumbnail preview */}
              {(!imageLanding || landingModel.model) && imagePreviewUrl && (
                <div className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200 shadow-sm">
                  <img
                    src={imagePreviewUrl}
                    alt="Uploaded preview"
                    className="w-20 h-20 object-cover rounded-md"
                  />
                  <div className="min-w-0 flex-1 text-left">
                    <p className="break-all text-sm font-medium text-slate-700">{imgFile?.name}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {imgFile && (imgFile.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={clearSelectedImage}
                    className="text-slate-400 hover:text-red-500 transition-colors"
                    aria-label="Remove image"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
              </LandingModelWorkspace>
            </div>}

          </div>

          {ldrawLanding && generationActivity}
          </div>
        </main>

        {!ldrawLanding && <div className="landing-page-help" aria-hidden={!helpVisible}>
          <div>Need help?{' '}
          <a href="mailto:support@brickbuilder.ai" tabIndex={helpVisible ? 0 : -1}
            onClick={() => posthog.capture('landing_help_email_clicked')}>support@brickbuilder.ai</a></div>
          <LandingSocialLinks visible={helpVisible} />
        </div>}
      </div>
    </div>
  );
}

function LandingHeader({ onLoginClick, page, generationSettings, createNew, model, modelBusy, toolsRef }: { toolsRef?: React.RefObject<LandingToolsHandle | null>; model?: LandingModel | null; modelBusy?: boolean; onLoginClick: () => void; page: string; generationSettings?: GenerationSettingsAction; createNew?: { onClick: () => void; disabled: boolean } }) {
  const { user, isSupabaseConfigured } = useAuth();
  const [githubStars, setGithubStars] = useState<number | null>(null);

  // Show profile menu if user is logged in OR if Supabase is not configured
  const showProfileMenu = user || !isSupabaseConfigured;

  useEffect(() => {
    let cancelled = false;

    fetch("https://api.github.com/repos/for-real-labs/brickbuilder-ai", {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to load GitHub stars");
        return response.json();
      })
      .then((repo: { stargazers_count?: number }) => {
        if (!cancelled && typeof repo.stargazers_count === "number") {
          setGithubStars(repo.stargazers_count);
        }
      })
      .catch(() => {
        if (!cancelled) setGithubStars(null);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const formattedGithubStars = githubStars === null
    ? "..."
    : new Intl.NumberFormat("en", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(githubStars);

  const githubStarLink = (
    <a
      href="https://github.com/for-real-labs/brickbuilder-ai"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View BrickBuilder on GitHub"
      className="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-full border border-black bg-black text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f44336] focus-visible:ring-offset-2 sm:w-auto sm:px-3"
    >
      <Github aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="hidden sm:inline">{formattedGithubStars}</span>
    </a>
  );

  return (
    <header className={`flex w-full flex-wrap items-center justify-between gap-y-2 relative landing-fade-in landing-delay-1${createNew ? ` landing-header--model${showProfileMenu ? '' : ' landing-header--guest-model'}` : ''}`} style={{ zIndex: 50 }}>
      <a href="/" className="flex min-w-0 items-center gap-2 sm:gap-3">
        <img
          src="/logo.svg"
          alt="BrickBuilder"
          className="h-6 w-auto sm:h-7"
          onError={(e) => {
            const el = e.currentTarget as HTMLImageElement;
            el.style.display = "none";
          }}
        />
        <span className="truncate text-lg font-extrabold tracking-tight sm:text-xl">
          <span className="text-[#ff4b4b]">BRICK</span>
          <span className="text-slate-900">BUILDER</span>
        </span>
      </a>

      {createNew && <button type="button" className="landing-create-new landing-action-button"
        disabled={createNew.disabled} onClick={createNew.onClick}>
        <Sparkles aria-hidden="true" className="h-4 w-4 shrink-0" /><span>Create new</span>
      </button>}
      {/* Login / Sign Up OR Account Menu */}
      <nav aria-label="Main navigation" className="flex shrink-0 items-center gap-2 sm:gap-3">
        {githubStarLink}
        <LandingToolsMenu ref={toolsRef} page={page} generationSettings={generationSettings} model={model} busy={modelBusy} />
        {showProfileMenu ? (
          // Logged in or no Supabase: show GitHub stars and account dropdown
          <>
            {/* Account dropdown */}
            <ProfileMenu />
          </>
        ) : (
          // Not logged in: show login button
          <>
            <button
              className="h-8 rounded-full border-none bg-[#f44336] px-3 text-xs font-medium text-white cursor-pointer transition-all duration-200 hover:-translate-y-px hover:bg-[#ff6b6b] sm:h-9 sm:px-4 sm:text-sm"
              onClick={onLoginClick}
            >
              Sign up
            </button>
          </>
        )}
      </nav>

    </header>
  );
}
