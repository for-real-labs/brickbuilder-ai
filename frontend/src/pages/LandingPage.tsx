import { startPolling } from '../utils/polling';
import { LandingToolsMenu, type GenerationSettingsAction } from '../components/LandingToolsMenu';
import { LDrawUploadSection } from '../components/LDrawUploadSection';
import { ImageUploadSection } from '../components/ImageUploadSection';
import { IMAGE_UPLOAD_ACCEPT, prepareImageUpload } from '../utils/prepareImageUpload';
import { IMAGE_LANDING_PAGES, type ImageLandingPath } from '../imageLandingPages';
import { usePromptTypewriter } from '../hooks/usePromptTypewriter';
import { GIFT_PROMPT_SUGGESTION } from '../utils/promptExamples';
import { NotificationMenu } from "../components/NotificationMenu";
import { CancelGenerationButton } from '../components/CancelGenerationButton';
import { PetPromptGreeting } from '../components/PetCompanion';
import { usePet, usePetActivity } from '../contexts/PetContext';
import { useGenerationNotifications } from '../contexts/GenerationNotificationsContext';
import { BuildBuddyDialogue } from '../components/BuildBuddyDialogue';
import { useBuildBuddyChat } from '../hooks/useBuildBuddyChat';
import { BUILD_FAILURE_MESSAGE } from '../utils/buildProgress';
import { useLandingModel } from '../hooks/useLandingModel';
import { LandingModelWorkspace, modelEditSuggestion } from '../components/LandingModelWorkspace';
import { buddyPromptSuggestion } from '../utils/buddyPromptSuggestion';
import { getGeneratedModelPath } from '../utils/generationRoutes';
import { useLandingViewport } from '../hooks/useLandingViewport';
import './LandingPage.css';

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Image as ImageIcon, Github, ChevronDown, Settings, X } from "lucide-react";
import { SEO } from "../components/SEO";
import FallingBricks from "../components/FallingBricks";
import LoginModal from "../components/LoginModal";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TextToBricksApiService } from "../services/textToBricksApi";
import { ImageToBricksApiService, StreamEvent, VoxelDataEvent, PipelineEvent } from "../services/imageToBricksApi";
import { GetGenerationApiService, GetGenerationResponse } from "../services/getGenerationApi";
import { recordAnonymousGeneration } from "../utils/anonGenerations";
import StreamingMeshViewer from "../components/StreamingMeshViewer";
import { useAuth } from "../contexts/AuthContext";
import { ProfileMenu } from "../components/ProfileMenu";
import { GenerationActivityList } from "../components/GenerationActivityList";
import { useGenerationActivity, isGenerationActive } from "../hooks/useGenerationActivity";
import { useAnimatedGenerationStats } from "../hooks/useAnimatedGenerationStats";
import { LlmPreviewLoader } from "../components/LlmPreviewLoader";
import { LocalProviderSettings } from "../components/LocalProviderSettings";
import { NovaProviderLoginModal, type NovaLoginProvider } from '../components/NovaProviderLoginModal';
import { DEFAULT_NOVA_OPTIONS, NovaToBricksApiService, type NovaBuilderOptions as NovaOptions } from "../services/novaToBricksApi";
import { isLocalDevelopment, LocalProvidersApiService } from "../services/localProvidersApi";
import { GenerationStats, GetGenerationStatsApiService } from "../services/getGenerationStatsApi";
import {
  DEFAULT_LLM_MODEL,
  GENERATION_MODEL_OPTIONS,
  LlmToBricksApiService,
  getLlmModelOption,
} from "../services/llmToBricksApi";
import posthog from "posthog-js";

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

// ---- In‑place loading: progress + messages ----
const LOADING_BEATS: Array<{ dur: number; text: string }> = [
  { dur: 2000, text: "Spinning up turbo hamsters..." },
  { dur: 2000, text: "Asking the AI nicely to imagine for you..." },
  { dur: 2000, text: "Translating dreams ➜ bricks..." },
  { dur: 2000, text: "Checking your vibe alignment coefficients..." },
  { dur: 2000, text: "Picking only the tastiest studs..." },
  { dur: 2000, text: "Hunting for the best brick deals (coupon ninja mode)" },
  { dur: 2000, text: "Making sure gravity will cooperate..." },
  { dur: 2000, text: "Polishing your pixels till they reflect the soul..." },
  { dur: 2000, text: "Applying secret sauce (proprietary™)" },
  { dur: 2000, text: "Snapping bricks with great satisfaction..." },
];

function useBeatText(active: boolean) {
  const [i, setI] = useState(0);
  const [fade, setFade] = useState(1);
  useEffect(() => {
    if (!active) {
      setI(0);
      setFade(1);
      return;
    }
    let alive = true;
    let currentIndex = 0;
    const loop = async () => {
      while (alive) {
        const beat = LOADING_BEATS[currentIndex % LOADING_BEATS.length];
        setI(currentIndex);
        setFade(1);
        await new Promise((r) => setTimeout(r, beat.dur));
        if (!alive) break;
        setFade(0.4);
        await new Promise((r) => setTimeout(r, 220));
        if (!alive) break;
        currentIndex++;
      }
    };
    loop();
    return () => { alive = false; };
  }, [active]);
  const text = LOADING_BEATS[i % LOADING_BEATS.length]?.text ?? "";
  return { text, fade };
}

export default function LandingPage({ imageLandingPath }: { imageLandingPath?: ImageLandingPath } = {}) {
  const { pet } = usePet();
  const { unread_count: unreadCompletions } = useGenerationNotifications();
  const ldrawLanding = imageLandingPath === 'use-ai-to-edit-ldraw';
  const imageLanding = imageLandingPath ? IMAGE_LANDING_PAGES[imageLandingPath] : null;
  const landingViewportRef = useLandingViewport(!ldrawLanding);
  const { session, userProfile, loading: authLoading } = useAuth();
  const buddyChat = useBuildBuddyChat(pet.id, session?.access_token, session?.user.id || 'guest');
  const { generations, error: activityError, trackGeneration, dismissGeneration } = useGenerationActivity(
    session?.user.id || "anonymous", session?.access_token, !authLoading,
  );
  const [prompt, setPrompt] = useState("");
  const [hasEnteredChat, setHasEnteredChat] = useState(false);
  const [giftPlanning, setGiftPlanning] = useState(false);
  const giftReplyPending = buddyChat.turns.some(turn => turn.kind === 'gift' && !turn.reply);
  useEffect(() => { setGiftPlanning(false); setHasEnteredChat(false); }, [session?.user.id]);
  useEffect(() => {
    if (hasEnteredChat) posthog.capture('build_buddy_contextual_suggestion_shown');
  }, [hasEnteredChat]);
  const [notificationPromptId, setNotificationPromptId] = useState<string | null>(null);
  const [orderBarHeight, setOrderBarHeight] = useState(0);
  const [inputValidationMessage, setInputValidationMessage] = useState<string | null>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsReturnFocus = useRef<HTMLButtonElement | null>(null);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const toggleSettings = (expanded: boolean) => {
    setSettingsOpen(expanded);
    posthog.capture('landing_generation_settings_toggled', { expanded });
  };
  const dismissSettings = () => {
    toggleSettings(false);
    (settingsReturnFocus.current || settingsButtonRef.current)?.focus();
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

  // NEW: in‑place loading state
  const [loading, setLoading] = useState(false);
  const generationAbortRef = useRef<AbortController | null>(null);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);
  const [activeLoadingMethod, setActiveLoadingMethod] = useState<GenerationMethod | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const { text: beatText, fade: beatFade } = useBeatText(loading);

  // Generated model state
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedModelId = searchParams.get('id');
  const landingModel = useLandingModel(session?.user.id || 'guest', session?.access_token, requestedModelId);
  const openModel = useCallback((id: string, retainModel = false) => {
    landingModel.open(id, retainModel);
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.set('id', id);
      next.set('exact', '1');
      return next;
    }, { replace: true });
  }, [landingModel.open, setSearchParams]);
  const ignoredModelIds = useRef(new Set<string>());
  const [editSubmitting, setEditSubmitting] = useState(false);
  const editSubmittingRef = useRef(false);
  const modelBusy = landingModel.busy || editSubmitting;
  const displayedGenerations = generations.map(row => row.id === landingModel.model?.generation.generation_id
    ? { ...row, status: 'completed', previewWaitUntil: undefined } : row);
  useEffect(() => {
    if (ldrawLanding || requestedModelId || landingModel.targetId) return;
    const latest = generations.filter(row => !ignoredModelIds.current.has(row.id)
      && (row.status === 'completed' || isGenerationActive(row.status)))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    if (latest) openModel(latest.id);
  }, [generations, ldrawLanding, requestedModelId, landingModel.targetId, openModel]);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Streaming 3D preview state
  const [voxelData, setVoxelData] = useState<VoxelDataEvent | null>(null);
  
  const navigate = useNavigate();
  const [generationStats, setGenerationStats] = useState<GenerationStats | null>(null);
  const displayedGenerationStats = useAnimatedGenerationStats(generationStats);
  useEffect(() => {
    const polling = startPolling(async (signal) => {
      try {
        const stats = await GetGenerationStatsApiService.getGenerationStats(signal);
        if (!signal.aborted) setGenerationStats(stats);
      } catch (error) {
        if (!signal.aborted) console.warn("Unable to load generation stats", error);
        throw error;
      }
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
    setPreviewImageUrl(null);
    setGenerationStatus(null);
    setVoxelData(null);
    
    // Clear old recently prompted generation ID before starting new one
    localStorage.removeItem('recently_prompted_generation_id');
    
    // Start loading
    setActiveLoadingMethod(generationMethod);
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
      
      // Shared stream-event handler used by both image and text streaming calls.
      const handleStreamEvent = (event: StreamEvent) => {
        if (controller.signal.aborted) return;
        // Update UI based on streaming events
        if ('type' in event && event.type === 'pipeline') {
          const pe = event as PipelineEvent;
          if (pe.generation_id) {
            setActiveGenerationId(pe.generation_id);
            clearSelectedImage();
          }
          if (pe.stage === 'image_generation') {
            const queueInfo = pe.queue_position != null ? ` (position ${pe.queue_position})` : '';
            setGenerationStatus(pe.message ? `${pe.message}${queueInfo}` : `Generating…${queueInfo}`);
            // Show live diffusion frames as they stream in
            if (pe.image_url) {
              setPreviewImageUrl(pe.image_url);
            }
          } else if (pe.stage === 'background_removal') {
            setGenerationStatus(pe.message || 'Processing input…');
            if (pe.progress === 100 && pe.image_url) {
              setPreviewImageUrl(pe.image_url);
            }
          } else if (pe.stage === 'input_processed') {
            setGenerationStatus(pe.message || 'Server booting up... (3-45 seconds)');
            if (pe.image_url) {
              setPreviewImageUrl(pe.image_url);
            }
          } else if (pe.stage === 'brick_conversion') {
            // Trellis (non-streamed) 3D step. Backend message looks like
            // "Generating 3D model... (queued)". Normalize to a clean status
            // keyword so the badge can show the right timing hint.
            const match = pe.message?.match(/\(([^)]+)\)/);
            const rawStatus = match?.[1]?.toLowerCase();
            if (rawStatus === 'queued') {
              setGenerationStatus('queued');
            } else if (rawStatus === 'processing' || rawStatus === 'started' || rawStatus === 'in_progress') {
              setGenerationStatus('processing');
            } else {
              setGenerationStatus('processing');
            }
          } else if (pe.message) {
            setGenerationStatus(pe.message);
          } else {
            setGenerationStatus(pe.stage);
          }
        } else if ('stage' in event && ((event as Record<string, unknown>).stage === 'geometry' || (event as Record<string, unknown>).stage === 'appearance')) {
          const vd = event as unknown as VoxelDataEvent;
          setVoxelData(vd);
          const label = vd.stage === 'appearance' ? 'Coloring bricks' : 'Generating shape';
          const pct = vd.progress != null ? ` ${Math.round(vd.progress * 100)}%` : '';
          setGenerationStatus(`${label}…${pct}`);
        }
      };

      // Image generation always streams via the SSE endpoint. The 3D model
      // only decides how the 3D step runs: SAM3D (streamed live voxels) or
      // Trellis (non-streamed).
      const stream3d = threeDModel === 'sam3d';

      if (generationMethod === 'nova') {
        setGenerationStatus('Starting the full set agent…');
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
        const llmLabel = getLlmModelOption(llmModel)?.label ?? 'The AI model';
        setGenerationStatus(`${llmLabel} is designing your brick model…`);
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
        setLoading(false);
        setActiveLoadingMethod(null);
        setGenerationStatus(null);
        return;
      }

      // Poll for completion with status updates
      const completedGeneration = await GetGenerationApiService.pollUntilComplete(
        generationId,
        (statusResponse: GetGenerationResponse) => {
          if (controller.signal.aborted) return;
          // Update status display
          setGenerationStatus(statusResponse.status);
          
          // Show preview image if available during processing
          if (statusResponse.external_image_url) {
            setPreviewImageUrl(statusResponse.external_image_url);
          }
        },
        2500, 120, controller.signal
      );
      
      console.log('Generation completed:', completedGeneration.generation_id);
      
      if (controller.signal.aborted) return;
      setLoading(false);
      setActiveLoadingMethod(null);
      setPreviewImageUrl(null);
      setGenerationStatus(null);
      openModel(completedGeneration.generation_id);
      if (!session) recordAnonymousGeneration(completedGeneration.generation_id);
      
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof DOMException && error.name === 'AbortError') {
        setLoading(false);
        setActiveLoadingMethod(null);
        setActiveGenerationId(null);
        setGenerationStatus(null);
        setPreviewImageUrl(null);
        setVoxelData(null);
        localStorage.removeItem('recently_prompted_generation_id');
        return;
      }
      console.error('Generation failed:', error);
      setGenerationError(BUILD_FAILURE_MESSAGE);
      buddyChat.updateTurn(turnId, { error: BUILD_FAILURE_MESSAGE, reply: undefined });
      setLoading(false);
      setActiveLoadingMethod(null);
      setPreviewImageUrl(null);
      setGenerationStatus(null);
      // Clear the recently prompted ID on failure
      localStorage.removeItem('recently_prompted_generation_id');
    }
  };

  const submitModelEdit = async (existingTurnId?: number, requestedPrompt = prompt) => {
    const model = landingModel.model;
    if (!model || modelBusy || editSubmittingRef.current || !requestedPrompt.trim()) return;
    editSubmittingRef.current = true;
    setEditSubmitting(true);
    setGenerationError(null);
    const submittedPrompt = requestedPrompt.trim();
    const sourceId = model.generation.generation_id;
    const turnId = existingTurnId ?? buddyChat.startTurn(submittedPrompt, null);
    buddyChat.requestReply(turnId, submittedPrompt);
    posthog.capture('landing_model_ai_edit_submitted', { generation_id: sourceId, prompt_length: submittedPrompt.length });
    try {
      const nova = model.generation.endpoint === 'novaToBricks' || model.generation.endpoint === 'uploadLdraw';
      const response = nova
        ? await NovaToBricksApiService.edit(sourceId, submittedPrompt, session?.access_token)
        : await LlmToBricksApiService.generate({ sourceGenerationId: sourceId, prompt: submittedPrompt }, session?.access_token);
      const id = response.generation_id;
      localStorage.setItem(STORAGE_KEYS.GENERATION_ID, id);
      if (!session) recordAnonymousGeneration(id);
      buddyChat.updateTurn(turnId, { generationId: id, method: nova ? 'nova' : 'llm' });
      trackGeneration({ id, prompt: submittedPrompt, status: 'started', endpoint: nova ? 'novaToBricks' : 'llmToBricks', createdAt: new Date().toISOString() });
      openModel(id, true);
      setNotificationPromptId(id);
      setPrompt('');
    } catch (error) {
      console.error('Model edit failed:', error);
      setGenerationError(BUILD_FAILURE_MESSAGE);
      buddyChat.updateTurn(turnId, { error: BUILD_FAILURE_MESSAGE, reply: undefined });
      posthog.capture('landing_model_ai_edit_failed', { generation_id: sourceId });
    } finally {
      editSubmittingRef.current = false;
      setEditSubmitting(false);
    }
  };

  const createNewModel = () => {
    posthog.capture('landing_model_create_new_clicked', { generation_id: landingModel.model?.generation.generation_id });
    generations.forEach(row => ignoredModelIds.current.add(row.id));
    if (landingModel.targetId) ignoredModelIds.current.add(landingModel.targetId);
    landingModel.reset();
    setSearchParams(current => {
      const next = new URLSearchParams(current);
      next.delete('id');
      next.delete('exact');
      return next;
    }, { replace: true });
    setGiftPlanning(false);
    setPrompt('');
    setGenerationError(null);
    setInputValidationMessage(null);
    clearSelectedImage();
    requestAnimationFrame(() => promptInputRef.current?.focus());
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
      ? 'Drag and drop an image anywhere on this page, or click the Upload image button below to choose one.'
      : 'Click the Upload image button below to choose a picture you’d like to turn into LEGO.' });
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
    if (result.intent === 'generate') {
      setGiftPlanning(false);
      if (landingModel.model) void submitModelEdit(result.id, text);
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
  const showTypewriter = !hasEnteredChat && buddyChat.turns.length === 0 && !focused && !prompt && !imgFile && !imageLanding && !giftPlanning && !loading && !preparingImage;
  const typedPlaceholder = usePromptTypewriter(showTypewriter);
  const contextualPlaceholder = buddyPromptSuggestion(buddyChat.turns, pet.name,
    landingModel.model ? modelEditSuggestion(landingModel.model) : undefined);
  const conversationStarted = !ldrawLanding && (unreadCompletions > 0 || buddyChat.turns.length > 0 || Boolean(landingModel.targetId) || loading
    || displayedGenerations.some(row => isGenerationActive(row.status)));

  const generationActivity = (
    <GenerationActivityList generations={displayedGenerations} error={activityError} onDismiss={dismissGeneration} buddyDialogue={!ldrawLanding}
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
      className={ldrawLanding ? "min-h-screen overflow-x-hidden text-slate-900 relative" : `landing-page text-slate-900${conversationStarted ? ' landing-page--conversation-started' : ''}`}
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
        description={imageLanding?.description ?? "Build brick models from text prompts or images. Experimental demo — results may vary."}
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
        <LandingHeader page={`/${imageLandingPath ?? ''}`} onLoginClick={() => setShowLoginModal(true)}
          generationSettings={ldrawLanding ? undefined : {
            open: settingsOpen,
            controls: localDevelopment ? 'landing-generation-settings landing-local-provider-settings' : 'landing-generation-settings',
            onOpen: trigger => { settingsReturnFocus.current = trigger; toggleSettings(true); },
          }} />

        <main className={`flex flex-1 flex-col items-center text-center w-full ${ldrawLanding ? '' : 'landing-page-main'}`}>
          <div className={`landing-page-intro${conversationStarted ? ' landing-page-intro--hidden' : ''}`} aria-hidden={conversationStarted}>
            <div className="landing-page-intro-content">
            <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl text-slate-900 landing-fade-in landing-delay-2">
              Imagine. Create. Build.
            </h1>

            <div
              className="flex items-center justify-center gap-4 sm:gap-8 text-slate-600 landing-fade-in landing-delay-2"
              aria-label="BrickBuilder generation statistics"
            >
              <div className="min-w-0">
                <span className="block text-xl font-bold sm:text-2xl tabular-nums text-slate-900">
                  {displayedGenerationStats ? displayedGenerationStats.generation_count.toLocaleString() : "—"}
                </span>
                <span className="whitespace-nowrap text-xs sm:text-sm">models generated</span>
              </div>
              <div className="h-10 w-px bg-slate-200" aria-hidden="true" />
              <div className="min-w-0">
                <span className="block text-xl font-bold sm:text-2xl tabular-nums text-slate-900">
                  {displayedGenerationStats ? displayedGenerationStats.brick_count.toLocaleString() : "—"}
                </span>
                <span className="whitespace-nowrap text-xs sm:text-sm">bricks generated</span>
              </div>
            </div>
            </div>
          </div>

          <div className={ldrawLanding ? 'w-full' : 'landing-page-content'}>
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6">
            {ldrawLanding && <div className="w-full landing-fade-in landing-delay-3">
              <PetPromptGreeting mode="upload" state={petState} showPetSwitch={false} />
              <h2 className="mb-1 text-left text-xl font-semibold text-slate-900">{imageLanding?.uploadTitle}</h2>
              <p className="mb-4 text-left text-sm text-slate-600">{imageLanding?.uploadDescription}</p>
              <LDrawUploadSection authToken={session?.access_token} onImported={id => {
                localStorage.setItem('lastGenerationId', id);
                if (!session) recordAnonymousGeneration(id);
                navigate(getGeneratedModelPath(id, true));
              }} />
            </div>}
            {!ldrawLanding && <div className="relative z-20 w-full">
              <LandingModelWorkspace model={landingModel.model} busy={modelBusy || buddyChat.routing}
                onOrderBarHeightChange={setOrderBarHeight}
                onCreateNew={createNewModel} onSuggest={suggestion => {
                  setPrompt(suggestion);
                  if (settingsOpen) toggleSettings(false);
                  promptInputRef.current?.focus();
                }}>
              <BuildBuddyDialogue turns={buddyChat.turns} generations={displayedGenerations}
                onViewGeneration={id => { openModel(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                state={(focused && !loading && !modelBusy) || buddyChat.routing ? 'listening' : petState} authLoading={authLoading}
                username={session ? userProfile?.username || session.user.user_metadata?.full_name || session.user.user_metadata?.name || session.user.user_metadata?.username : null}
                actionsDisabled={loading || buddyChat.routing || preparingImage || modelBusy || giftReplyPending || Boolean(landingModel.model)}
                onUploadImage={() => onPickImage('buddy_dialogue')} onUseGiftIdea={idea => {
                  posthog.capture('build_buddy_gift_idea_selected');
                  setGiftPlanning(false);
                  setPrompt(idea);
                  if (settingsOpen) toggleSettings(false);
                  promptInputRef.current?.focus();
                }}>
                {generationActivity}
              </BuildBuddyDialogue>
            <form
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
                  {!landingModel.model && <button type="button" aria-label="Upload image" title="Upload image"
                    disabled={loading || buddyChat.routing || preparingImage} onClick={() => { setGiftPlanning(false); onPickImage('input_left_icon'); }}
                    className="absolute left-2 top-1/2 z-10 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-red-50 hover:text-[#f44336] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50">
                    <ImageIcon aria-hidden="true" className="h-5 w-5" />
                  </button>}
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
                    placeholder={imgFile ? "Add optional image instructions" : hasEnteredChat || buddyChat.turns.length > 0 ? contextualPlaceholder : imageLanding ? "add optional instructions" : showTypewriter ? typedPlaceholder : `Tell ${pet.name} what you’d like to build…`}
                    className={`pet-conversation-input h-16 w-full rounded-2xl border border-gray-200 bg-white ${landingModel.model ? 'pl-4' : 'pl-14'} pr-16 text-base shadow-sm transition-colors focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50`}
                    disabled={loading || buddyChat.routing || preparingImage || (Boolean(landingModel.model) && modelBusy)}
                  />
                  <button
                    type="submit" aria-label={sendLabel} title={sendLabel}
                    disabled={loading || buddyChat.routing || preparingImage || giftReplyPending || (Boolean(landingModel.model) && modelBusy)}
                    className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-[#f44336] text-white transition-colors hover:bg-[#ff6b6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowUp aria-hidden="true" className="h-5 w-5" />
                  </button>
                </div>
                <button ref={settingsButtonRef} type="button" aria-label="Generation settings" title="Generation settings"
                  aria-expanded={settingsOpen} aria-controls={localDevelopment ? "landing-generation-settings landing-local-provider-settings" : "landing-generation-settings"}
                  onClick={event => { settingsReturnFocus.current = event.currentTarget; toggleSettings(!settingsOpen); }}
                  className={`hidden h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 sm:inline-flex ${settingsOpen ? 'border-red-200 bg-red-50 text-[#f44336]' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}>
                  <Settings aria-hidden="true" className="h-5 w-5" />
                </button>
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
            </form>
              {landingModel.error && <p role="alert" className="mt-3 text-left text-sm text-red-600">{landingModel.error}</p>}
              {modelBusy && <p role="status" className="mt-3 text-left text-sm text-slate-500">{landingModel.model ? 'Updating your model… You can keep viewing it while your edit builds.' : 'Your model will appear here when it’s ready.'}</p>}
              {!ldrawLanding && localDevelopment && !loading && <div id="landing-local-provider-settings" hidden={!settingsOpen} onKeyDown={handleSettingsKeyDown} className="w-full">
                <LocalProviderSettings />
              </div>}

              {!imageLanding && imageUploadError && <p role="alert" className="text-sm text-red-600">{imageUploadError}</p>}
              {!imageLanding && preparingImage && <p role="status" className="text-sm text-slate-500">Preparing your image…</p>}
              {/* Image thumbnail preview */}
              {!imageLanding && imagePreviewUrl && (
                <div className="flex items-center gap-3 p-3 bg-white rounded-lg border border-gray-200 shadow-sm">
                  <img
                    src={imagePreviewUrl}
                    alt="Uploaded preview"
                    className="w-20 h-20 object-cover rounded-md"
                  />
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium text-slate-700">{imgFile?.name}</p>
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
          {loading && activeGenerationId && <div className="flex justify-center mb-4">
            <CancelGenerationButton generationId={activeGenerationId} onCancelled={() => {
              generationAbortRef.current?.abort();
              setLoading(false);
              setActiveLoadingMethod(null);
              setActiveGenerationId(null);
              setGenerationStatus(null);
              setPreviewImageUrl(null);
              setVoxelData(null);
              localStorage.removeItem('recently_prompted_generation_id');
            }} />
          </div>}
          {/* Keep active generation feedback visible before the user scrolls. */}
          <section className="mt-4 w-full relative landing-fade-in landing-delay-4" style={{ zIndex: 15 }}>
            {loading && (
              <div className="flex w-full flex-col items-center gap-4 mb-4">
                {/* Preview container with overlaid status + beat text */}
                <div className="relative w-full max-w-md overflow-hidden rounded-xl shadow-lg border border-slate-200" style={{ height: 340 }}>
                  {/* Content layer */}
                  {voxelData ? (
                    <div style={{ height: 340 }}>
                      <StreamingMeshViewer voxelData={voxelData} />
                    </div>
                  ) : activeLoadingMethod === 'llm' || activeLoadingMethod === 'nova' ? (
                    <LlmPreviewLoader previewImageUrl={previewImageUrl} />
                  ) : previewImageUrl ? (
                    <img
                      src={previewImageUrl}
                      alt="Generation preview"
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="w-full flex items-center justify-center bg-slate-50" style={{ height: 340 }}>
                      <div className="text-slate-300 text-sm">Preparing preview…</div>
                    </div>
                  )}

                  {/* Status badge — overlayed on top center */}
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1" style={{ zIndex: 10 }}>
                    <div className="text-xs text-slate-600 font-mono bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
                      Status: {generationStatus === 'queued'
                        ? 'Queued'
                        : (generationStatus === 'processing' || generationStatus === 'started')
                          ? 'Generating 3D model'
                          : (generationStatus || 'Starting')}
                    </div>
                    {generationStatus === 'queued' && (
                      <div className="text-xs text-slate-500 bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
                        This will take about 1-2 minutes
                      </div>
                    )}
                    {(generationStatus === 'processing' || generationStatus === 'started') && (
                      <div className="text-xs text-slate-500 bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full shadow-sm whitespace-nowrap">
                        This will take about 30-60 seconds
                      </div>
                    )}
                  </div>

                  {/* Rotating beat text — overlayed on bottom center */}
                  <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-w-[90%]" style={{ zIndex: 10 }}>
                    <div
                      className="text-xs sm:text-sm text-center bg-white/80 backdrop-blur-sm px-3 py-1.5 rounded-full shadow-sm whitespace-nowrap"
                      style={{ color: `rgba(30, 41, 59, ${beatFade})`, transition: 'color 250ms ease' }}
                    >
                      {beatText}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
          </div>
        </main>

      </div>
    </div>
  );
}

function LandingHeader({ onLoginClick, page, generationSettings }: { onLoginClick: () => void; page: string; generationSettings?: GenerationSettingsAction }) {
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
      className="hidden h-8 min-w-[4.5rem] items-center justify-center gap-1.5 rounded-full bg-slate-100 px-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 sm:inline-flex sm:h-9 sm:min-w-[5.25rem] sm:gap-2 sm:px-3 sm:text-sm"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-950 text-white sm:h-6 sm:w-6">
        <Github className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
      </span>
      <span>{formattedGithubStars}</span>
    </a>
  );

  return (
    <header className="flex w-full flex-wrap items-center justify-between gap-y-2 relative landing-fade-in landing-delay-1" style={{ zIndex: 50 }}>
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

      {/* Login / Sign Up OR Account Menu */}
      <nav aria-label="Main navigation" className="flex shrink-0 items-center gap-2 sm:gap-3">
        {githubStarLink}
        <LandingToolsMenu page={page} generationSettings={generationSettings} />
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
        {!showProfileMenu && <NotificationMenu />}
      </nav>

    </header>
  );
}
