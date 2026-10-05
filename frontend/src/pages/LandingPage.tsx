import { usePromptTypewriter as useTypewriter } from '../hooks/usePromptTypewriter';
import { NotificationMenu } from "../components/NotificationMenu";
import { CancelGenerationButton } from '../components/CancelGenerationButton';

import React, { useEffect, useLayoutEffect, useRef, useState, memo } from "react";
import { Sparkles, Image as ImageIcon, Users, Calendar, Eye, X, MessageSquare, Wand2, Package, Github, LayoutDashboard, Box, ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { SEO } from "../components/SEO";
import FallingBricks from "../components/FallingBricks";
import LoginModal from "../components/LoginModal";
import { useNavigate } from "react-router-dom";
import { TextToBricksApiService } from "../services/textToBricksApi";
import { ImageToBricksApiService, StreamEvent, VoxelDataEvent, PipelineEvent } from "../services/imageToBricksApi";
import { GetGenerationApiService, GetGenerationResponse } from "../services/getGenerationApi";
import { recordAnonymousGeneration } from "../utils/anonGenerations";
import StreamingMeshViewer from "../components/StreamingMeshViewer";
import { LdrToMpdApiService } from "../services/ldrToMpdApi";
import { useAuth } from "../contexts/AuthContext";
import { SiteFooter } from "../components/SiteFooter";
import { ProfileMenu } from "../components/ProfileMenu";
import { GenerationActivityList } from "../components/GenerationActivityList";
import { useGenerationActivity } from "../hooks/useGenerationActivity";
import { useAnimatedGenerationStats } from "../hooks/useAnimatedGenerationStats";
import { LlmPreviewLoader } from "../components/LlmPreviewLoader";
import { LocalProviderSettings } from "../components/LocalProviderSettings";
import { NovaProviderLoginModal, type NovaLoginProvider } from '../components/NovaProviderLoginModal';
import { DEFAULT_NOVA_OPTIONS, NovaToBricksApiService, type NovaBuilderOptions as NovaOptions } from "../services/novaToBricksApi";
import { isLocalDevelopment, LocalProvidersApiService } from "../services/localProvidersApi";
import { GenerationStats, GetGenerationStatsApiService } from "../services/getGenerationStatsApi";
import { CommunityGeneration, GetCommunityGenerationsApiService } from "../services/getCommunityGenerationsApi";
import {
  DEFAULT_LLM_MODEL,
  LLM_MODEL_OPTIONS,
  LlmProvider,
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
export const DEFAULT_GENERATION_METHOD: GenerationMethod = "llm";
export type ThreeDModel = "sam3d" | "trellis";
export const DEFAULT_THREE_D_MODEL: ThreeDModel = "sam3d";
const LLM_PROVIDER_GROUPS: Array<{ provider: LlmProvider; label: string }> = [
  { provider: "anthropic", label: "Claude" },
  { provider: "openai", label: "OpenAI" },
];

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
    <div className="relative min-w-0 basis-[calc(50%-0.25rem)] sm:basis-auto">
      <label htmlFor="landing-render-model" className="sr-only">Model</label>
      <select
        id="landing-render-model"
        value={model}
        disabled={disabled}
        onChange={event => {
          const option = getLlmModelOption(event.target.value);
          const selected = event.target.value;
          const other = selected === 'sam3d' || selected === 'trellis';
          if ((!option && !other) || selected === model || disabled) return;
          onChange(selected);
          posthog.capture('landing_render_model_selected', {
            generation_method: other ? '3d' : mode === '3d' ? 'llm' : mode, model: selected, provider: option?.provider ?? 'fal',
          });
        }}
        className="min-h-11 w-full min-w-0 appearance-none cursor-pointer rounded-full border border-slate-200 bg-white py-2 pl-4 pr-10 text-sm text-slate-700 transition-colors hover:border-red-200 focus:border-[#f44336] focus:outline-none focus:ring-2 focus:ring-red-100 disabled:cursor-not-allowed disabled:opacity-50 sm:w-52"
      >
        {LLM_PROVIDER_GROUPS.map(group => (
          <optgroup key={group.provider} label={group.label}>
            {LLM_MODEL_OPTIONS.filter(option => option.provider === group.provider).map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </optgroup>
        ))}
        <optgroup label="Other">
          <option value="sam3d">SAM3D</option>
          <option value="trellis">Trellis</option>
        </optgroup>
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

const NAV_LINKS = [
  { label: "Products", href: "#products" },
  { label: "Models", href: "#models" },
  { label: "Created", href: "#created" },
  { label: "Today", href: "#today" },
];

type FeaturedItem = {
  id: string;
  title: string;
  imageUrl: string | null;
  creator: string | null;
  createdAt: string;
  likeCount: number;
};

const toFeaturedItem = (generation: CommunityGeneration): FeaturedItem => ({
  id: generation.id,
  title: generation.name?.trim() || "Untitled Model",
  imageUrl: generation.preview_image_url
    || generation.external_image_url
    || generation.image_url
    || generation.thumbnail_url
    || generation.processed_image_url
    || null,
  creator: generation.username?.trim() || null,
  createdAt: generation.created_at,
  likeCount: generation.like_count ?? 0,
});

function ScrollRevealContent({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const elements = ref.current?.querySelectorAll('.landing-fade-in') || [];
    if (!('IntersectionObserver' in window)) {
      elements.forEach(element => element.classList.add('landing-visible'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('landing-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0 });
    elements.forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return <div ref={ref} className="landing-scroll-reveal contents">{children}</div>;
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

export default function LandingPage() {
  const { session, loading: authLoading } = useAuth();
  const { generations, error: activityError, trackGeneration } = useGenerationActivity(
    session?.user.id || "anonymous", session?.access_token, !authLoading,
  );
  const [prompt, setPrompt] = useState("");
  const [inputValidationMessage, setInputValidationMessage] = useState<string | null>(null);
  const promptInputRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState<SizeValue>("big");
  const [modelQuality, setModelQuality] = useState<ModelQuality>("regular");
  const [generationMethod, setGenerationMethod] = useState<GenerationMethod>(DEFAULT_GENERATION_METHOD);
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

  const [focused, setFocused] = useState(false);
  const showTypewriter = !focused && prompt.length === 0;
  const typedPlaceholder = useTypewriter(showTypewriter);

  // NEW: in‑place loading state
  const [loading, setLoading] = useState(false);
  const generationAbortRef = useRef<AbortController | null>(null);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);
  const [activeLoadingMethod, setActiveLoadingMethod] = useState<GenerationMethod | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const { text: beatText, fade: beatFade } = useBeatText(loading);

  // Generated model state
  const [generatedMpdContent, setGeneratedMpdContent] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Streaming 3D preview state
  const [voxelData, setVoxelData] = useState<VoxelDataEvent | null>(null);
  
  // Last completed generation (shown as a row)
  const [lastGeneration, setLastGeneration] = useState<GetGenerationResponse | null>(null);

  const navigate = useNavigate();
  const [isCardHidden, setIsCardHidden] = useState(false);
  const [generationStats, setGenerationStats] = useState<GenerationStats | null>(null);
  const displayedGenerationStats = useAnimatedGenerationStats(generationStats);
  const [statsReady, setStatsReady] = useState(false);
  const [communityReady, setCommunityReady] = useState(false);
  const lowerContentReady = statsReady && communityReady;
  const [featuredCommunityModels, setFeaturedCommunityModels] = useState<FeaturedItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    const loadGenerationStats = () => {
      GetGenerationStatsApiService.getGenerationStats(controller.signal)
        .then(setGenerationStats)
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          console.warn("Unable to load generation stats", error);
        })
        .finally(() => {
          if (!controller.signal.aborted) setStatsReady(true);
        });
    };

    loadGenerationStats();
    const interval = window.setInterval(loadGenerationStats, 30_000);

    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    GetCommunityGenerationsApiService.getCommunityGenerations(
      undefined,
      8,
      0,
      undefined,
      'top',
    )
      .then((response) => {
        if (cancelled) return;
        setFeaturedCommunityModels((response.generations || []).slice(0, 8).map(toFeaturedItem));
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("Unable to load featured community models", error);
          setFeaturedCommunityModels([]);
        }
      })
      .finally(() => {
        if (!cancelled) setCommunityReady(true);
      });

    return () => {
      cancelled = true;
    };
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
      setGenerationMethod(payload.generationMethod === '3d' ? '3d' : payload.generationMethod === 'nova' ? 'nova' : 'llm');
      if (payload.threeDModel === 'sam3d' || payload.threeDModel === 'trellis') setThreeDModel(payload.threeDModel);
      if (payload.llmModel && getLlmModelOption(payload.llmModel)) setLlmModel(payload.llmModel);
      if (payload.novaOptions && getLlmModelOption(payload.novaOptions.model)) {
        setNovaOptions({ ...DEFAULT_NOVA_OPTIONS, ...payload.novaOptions, authMode: localDevelopment && payload.novaOptions.authMode === 'native' ? 'native' : 'api_key' });
        if (payload.generationMethod === 'nova') setLlmModel(payload.novaOptions.model);
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

  // Function to save model to localStorage (same as BrickBuilder)
  const saveModelToStorage = (ldrContent?: string, mpdContent?: string, modelName?: string, generationId?: string) => {
    try {
      if (ldrContent) {
        localStorage.setItem(STORAGE_KEYS.LDR_CONTENT, ldrContent);
      }
      if (mpdContent) {
        localStorage.setItem(STORAGE_KEYS.MPD_CONTENT, mpdContent);
      }
      if (modelName) {
        localStorage.setItem(STORAGE_KEYS.MODEL_NAME, modelName);
      }
      if (generationId && generationId.trim()) {
        localStorage.setItem(STORAGE_KEYS.GENERATION_ID, generationId);
      } else {
        localStorage.removeItem(STORAGE_KEYS.GENERATION_ID);
      }
      localStorage.setItem(STORAGE_KEYS.GENERATED_AT, new Date().toISOString());
      console.log('Model saved to localStorage');
    } catch (error) {
      console.error('Error saving model to localStorage:', error);
    }
  };

  const onPickImage = () => fileInputRef.current?.click();
  const clearSelectedImage = () => {
    setImgFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const onFileChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    if (e.target.files?.length) setInputValidationMessage(null);
    const file = e.target.files?.[0] ?? null;
    setImgFile(file);
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
    if (loading) return;
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      setImgFile(file);
    }
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

  const onGenerate = async () => {
    // Prevent multiple simultaneous calls
    if (loading || checkingProviderRef.current || providerLogin) return;

    // Validate input: either text prompt or image required
    if (!imgFile && !prompt.trim()) {
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
    setGeneratedMpdContent(null);
    setGenerationError(null);
    setPreviewImageUrl(null);
    setGenerationStatus(null);
    setLastGeneration(null); // Clear previous generation card
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
    
    try {
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
        const imageBase64 = imgFile ? await fileToBase64(imgFile) : undefined;
        setGenerationStatus('Starting the full set agent…');
        postResponse = await NovaToBricksApiService.generate({
          ...novaOptions,
          model: llmModel,
          authMode: localDevelopment ? novaAuthMode : 'api_key',
          prompt: prompt.trim() || undefined,
          imageBase64,
          imageMediaType: imgFile?.type || 'image/png',
          detailLevel: getVoxelSize(size),
        }, authToken);
        modelName = prompt.trim() || imgFile?.name.replace(/\.[^/.]+$/, '') || 'full-set-model';
      } else if (generationMethod === 'llm') {
        const imageBase64 = imgFile ? await fileToBase64(imgFile) : undefined;
        const llmLabel = getLlmModelOption(llmModel)?.label ?? 'The AI model';
        setGenerationStatus(`${llmLabel} is designing your brick model…`);
        postResponse = await LlmToBricksApiService.generate(
          {
            prompt: prompt.trim() || undefined,
            imageBase64,
            imageMediaType: imgFile?.type || 'image/png',
            detailLevel: getVoxelSize(size),
            model: llmModel,
          },
          authToken,
        );
        modelName = prompt.trim() || imgFile?.name.replace(/\.[^/.]+$/, '') || 'llm-model';
      } else if (imgFile) {
        console.log(`Generating from image (3D model: ${threeDModel}):`, imgFile.name);
        const imageBase64 = await fileToBase64(imgFile);
        postResponse = await ImageToBricksApiService.generateBricksFromImageStream(
          imageBase64,
          getVoxelSize(size),
          authToken,
          modelOption,
          promptOption,
          handleStreamEvent,
          stream3d,
          'trimesh',
          prompt.trim(),
          controller.signal,
        );
        modelName = prompt.trim() || imgFile.name.replace(/\.[^/.]+$/, ''); // Remove file extension
      } else {
        console.log(`Generating from text prompt (3D model: ${threeDModel}):`, prompt.trim());
        postResponse = await TextToBricksApiService.generateBricksFromTextStream(
          prompt.trim(),
          getVoxelSize(size),
          authToken,
          modelOption,
          promptOption,
          handleStreamEvent,
          stream3d,
          'trimesh',
          controller.signal,
        );
        modelName = prompt.trim();
      }
      
      if (controller.signal.aborted) return;
      const generationId = postResponse.generation_id;
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
        trackGeneration({ id: generationId, prompt: modelName, status: 'started', endpoint: generationMethod === 'nova' ? 'novaToBricks' : 'llmToBricks', createdAt: generationStartedAt });
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
      
      // Get MPD content - either from URL or convert LDR to MPD
      let mpdContent: string | null = null;
      if (completedGeneration.mpd_url) {
        try {
          const mpdResponse = await fetch(completedGeneration.mpd_url);
          if (mpdResponse.ok) {
            mpdContent = await mpdResponse.text();
          }
        } catch (mpdError) {
          console.warn('Failed to fetch MPD from URL:', mpdError);
        }
      }
      
      // Fallback: convert LDR to MPD if MPD URL wasn't available or failed
      if (!mpdContent && completedGeneration.ldr_content) {
        try {
          const mpdData = await LdrToMpdApiService.convertLdrToMpd(
            completedGeneration.ldr_content,
            modelName,
            authToken
          );
          mpdContent = mpdData.mpd_content;
        } catch (mpdError) {
          console.warn('Failed to convert LDR to MPD:', mpdError);
        }
      }
      
      if (controller.signal.aborted) return;
      setGeneratedMpdContent(mpdContent);
      setLoading(false);
      setActiveLoadingMethod(null);
      setPreviewImageUrl(null);
      setGenerationStatus(null);
      
      // Save to localStorage for persistence across browser refreshes
      saveModelToStorage(
        completedGeneration.ldr_content,
        mpdContent || undefined,
        modelName,
        completedGeneration.generation_id
      );
      
      // Navigate to generated model page since this completed from loading state
      if (!session) recordAnonymousGeneration(completedGeneration.generation_id);
      navigate(`/generated-model?id=${completedGeneration.generation_id}`);
      
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
      // Check if error is a network error - if user is online but fetch failed, backend is likely not running
      const isNetworkError = error instanceof TypeError && error.message === 'Failed to fetch';
      const errorMsg = error instanceof Error ? error.message : '';
      
      let errorMessage = 'Generation failed. Please try again';
      if (isNetworkError) {
        errorMessage = navigator.onLine 
          ? 'Backend services not running. Check terminal for errors.' 
          : 'No internet connection';
      } else if (errorMsg.includes('FAL_KEY')) {
        // Backend is running but FAL_KEY is not configured
        errorMessage = 'FAL_KEY not configured. Set FAL_KEY in .env file and restart the backend server.';
      } else if (errorMsg) {
        // Use the error message from the backend
        errorMessage = errorMsg;
      }
      setGenerationError(errorMessage);
      setLoading(false);
      setActiveLoadingMethod(null);
      setPreviewImageUrl(null);
      setGenerationStatus(null);
      // Clear the recently prompted ID on failure
      localStorage.removeItem('recently_prompted_generation_id');
    }
  };

  const submitGeneration = () => {
    if (loading) return;
    posthog.capture('landing_generate_clicked', {
      generation_method: generationMethod,
      model: generationMethod === '3d' ? threeDModel : llmModel,
      has_prompt: Boolean(prompt.trim()),
      has_image: Boolean(imgFile),
      size,
      is_authenticated: Boolean(session),
    });
    void onGenerate();
  };

  // After a successful login from the modal, automatically continue generation
  useEffect(() => {
    if (pendingGenerateAfterLogin && session && !authLoading && !loading) {
      setPendingGenerateAfterLogin(false);
      onGenerate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGenerateAfterLogin, session, authLoading]);

  return (
    <div
      className="min-h-screen overflow-x-hidden text-slate-900 relative"
      style={{ backgroundColor: "#fbfbfd" }}
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
        title="BrickBuilder - Turn Images into 3D LEGO-Compatible Brick Models"
        description="Build brick models from text prompts or images. Experimental demo — results may vary."
        url="https://brickbuilder.ai/landing"
      />

      <FallingBricks density={22} opacity={0.25} zIndex={0} />

      <LoginModal
        open={showLoginModal}
        onClose={() => {
          setShowLoginModal(false);
          setPendingGenerateAfterLogin(false);
        }}
        onSuccess={() => setShowLoginModal(false)}
        redirectTo="/"
        onBeforeOAuthRedirect={savePendingLandingState}
      />
      <NovaProviderLoginModal provider={providerLogin} onClose={() => setProviderLogin(null)} onConnected={mode => {
        if (providerLogin) providerChoices.current[providerLogin] = mode;
        setNovaOptions(current => ({ ...current, authMode: mode }));
        setProviderLogin(null);
      }} />

      <div className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-6 relative" style={{ zIndex: 10 }}>
        <LandingHeader onLoginClick={() => setShowLoginModal(true)} />

        <main className="flex flex-1 flex-col items-center text-center w-full">
          <div className="mt-4 flex w-full max-w-3xl flex-col items-center gap-6 sm:mt-8">
            <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl text-slate-900 landing-fade-in landing-delay-2">
              Imagine. Create. Build.
            </h1>

            <p className="text-lg text-slate-600 landing-fade-in landing-delay-2">Turn images or text into buildable 3D brick models in seconds</p>

            <div
              className="flex items-center justify-center gap-8 text-slate-600 landing-fade-in landing-delay-2"
              aria-label="BrickBuilder generation statistics"
            >
              <div className="min-w-28">
                <span className="block text-2xl font-bold text-slate-900">
                  {displayedGenerationStats ? displayedGenerationStats.generation_count.toLocaleString() : "—"}
                </span>
                <span className="text-sm">models generated</span>
              </div>
              <div className="h-10 w-px bg-slate-200" aria-hidden="true" />
              <div className="min-w-28">
                <span className="block text-2xl font-bold text-slate-900">
                  {displayedGenerationStats ? displayedGenerationStats.brick_count.toLocaleString() : "—"}
                </span>
                <span className="text-sm">bricks generated</span>
              </div>
            </div>

            <form
              aria-label="Create a brick model"
              className="relative z-20 w-full landing-fade-in landing-delay-3"
              onSubmit={event => {
                event.preventDefault();
                submitGeneration();
              }}
            >
              <div className="relative w-full">
                <input
                  ref={promptInputRef}
                  aria-label="Describe your model"
                  aria-describedby={inputValidationMessage ? "generation-input-help" : undefined}
                  value={prompt}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setPrompt(event.target.value);
                    if (event.target.value.trim()) setInputValidationMessage(null);
                  }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    if (event.repeat || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                    event.currentTarget.form?.requestSubmit();
                  }}
                  placeholder={imgFile ? "Add optional image instructions" : (showTypewriter ? typedPlaceholder : "")}
                  className="h-16 w-full rounded-2xl border border-gray-200 bg-white pl-4 pr-28 text-base shadow-sm transition-colors focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500 disabled:cursor-not-allowed disabled:opacity-50 sm:pl-5 sm:pr-36"
                  disabled={loading}
                />
                <button
                  type="submit"
                  disabled={loading}
                  className="absolute right-2 top-1/2 inline-flex h-12 -translate-y-1/2 items-center justify-center gap-2 rounded-xl bg-[#f44336] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#ff6b6b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:px-6 sm:text-base"
                >
                  <Sparkles aria-hidden="true" className="h-4 w-4 sm:h-5 sm:w-5" />
                  Create
                </button>
              </div>

              {inputValidationMessage && (
                <p id="generation-input-help" role="status" className="mt-3 text-center text-sm leading-6 text-slate-600">
                  {inputValidationMessage}
                </p>
              )}
              {generationMethod === 'nova' && (
                <p id="all-parts-warning" className="mt-2 text-left text-xs leading-relaxed text-slate-500">
                  Warning: all parts mode is experimental. Generations take up to 30 minutes and output needs to be verified in instructions.
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2 text-left sm:gap-3">
                <div id="landing-builder-mode" role="group" aria-label="Mode"
                  aria-describedby={generationMethod === 'nova' ? 'all-parts-warning' : undefined}
                  className="flex min-h-11 w-full shrink-0 items-center rounded-full border border-slate-200 bg-slate-100 p-1 sm:w-auto">
                  {([{ value: 'llm', label: 'Basic bricks' }, { value: 'nova', label: 'All parts' }] as const).map(({ value, label }) => (
                    <button key={value} type="button" value={value}
                      aria-pressed={(generationMethod === '3d' ? 'llm' : generationMethod) === value}
                      disabled={loading || checkingProvider || generationMethod === '3d'}
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
                }} disabled={loading || checkingProvider} />
                <button
                  type="button"
                  onClick={onPickImage}
                  className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 transition-colors hover:border-red-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Upload image"
                  disabled={loading}
                >
                  <ImageIcon aria-hidden="true" className="h-4 w-4" />
                  Upload image
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onFileChange} disabled={loading} />
              </div>
              {localDevelopment && generationMethod === 'nova' && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-left text-sm text-slate-600">
                  <label htmlFor="nova-connection">Provider connection</label>
                  <select id="nova-connection" value={novaOptions.authMode} disabled={loading || checkingProvider} className="min-h-11 rounded-full border border-slate-200 bg-white px-3" onChange={event => {
                    const provider = getLlmModelOption(llmModel)?.provider as NovaLoginProvider;
                    if (event.target.value === 'native') { delete providerChoices.current[provider]; void checkNovaConnection(llmModel); }
                    else { providerChoices.current[provider] = 'api_key'; setNovaOptions(current => ({ ...current, authMode: 'api_key' })); }
                  }}>
                    <option value="api_key">Project API key</option>
                    <option value="native">{getLlmModelOption(llmModel)?.provider === 'openai' ? 'Signed in to ChatGPT' : 'Signed in to Claude'} · local account</option>
                  </select>
                </div>
              )}
              {checkingProvider && <p role="status" className="mt-2 text-left text-sm text-slate-500">Checking provider connection…</p>}
            </form>

            {/* Image thumbnail preview */}
            {imagePreviewUrl && (
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

            {localDevelopment && !loading && <LocalProviderSettings />}

            {!loading && (
              <>
                {/* <p className="mt-2 text-sm text-slate-500 landing-fade-in landing-delay-3">
                  This app uses generative AI to create brick models. Results may vary.
                </p> */}

                {/* Last completed generation */}
                {/* {lastGeneration && !isCardHidden && (
                  <div className="mt-4 w-full max-w-xl rounded-xl border border-slate-200 bg-white shadow-sm relative">
                    <button
                      onClick={() => setIsCardHidden(true)}
                      className="absolute top-3 right-3 p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
                      aria-label="Hide card"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <div className="p-4 flex gap-4">
                      <div className="w-20 h-20 rounded-lg overflow-hidden bg-slate-100 border flex items-center justify-center">
                        {lastGeneration.external_image_url ? (
                          <img src={lastGeneration.external_image_url} alt={lastGeneration.generation_id} className="w-full h-full object-cover" />
                        ) : (
                          <Sparkles className="w-6 h-6 text-slate-300" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-sm text-slate-900 truncate">id: {lastGeneration.generation_id}</h3>
                        <div className="flex items-center gap-3 text-xs text-slate-500 mt-1">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3"/> Recently created
                          </span>
                        </div>
                        <button 
                          onClick={() => navigate(`/generated-model?id=${lastGeneration.generation_id}`)}
                          className="mt-2 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs hover:bg-slate-50 cursor-pointer"
                        >
                          <Eye className="w-3.5 h-3.5"/> View Model
                        </button>
                      </div>
                    </div>
                  </div>
                )} */}
              </>
            )}
          </div>

            <GenerationActivityList generations={generations} error={activityError}
              onOpen={id => navigate(`/generated-model?id=${id}`)}
              onResumed={(sourceId, newId) => {
                const row = generations.find(generation => generation.id === sourceId);
                if (row) trackGeneration({ ...row, id: newId, status: 'started', errorMessage: undefined,
                  createdAt: new Date().toISOString(), previewWaitUntil: undefined }, sourceId);
              }}
              onCancelled={id => {
                const row = generations.find(generation => generation.id === id);
                if (row) trackGeneration({ ...row, status: 'cancelled', previewWaitUntil: undefined });
              }} />
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
          {lowerContentReady && <ScrollRevealContent>
          {/* Featured horizontal marquee OR in‑place progress UI */}
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
            {generationError && (
              <div className="flex flex-col items-center gap-4 mb-4">
                <div className="text-red-600 text-center">
                  <h3 className="text-lg font-semibold mb-2">Generation Failed</h3>
                  <p>{generationError}</p>
                </div>
                <button
                  onClick={() => {
                    setGenerationError(null);
                  }}
                  className="px-4 py-2 border border-slate-300 text-slate-700 rounded-full hover:bg-slate-50 transition-colors"
                >
                  Try Again
                </button>
              </div>
            )}
            {featuredCommunityModels.length > 0 && (
              <div className="w-screen relative left-1/2 -translate-x-1/2">
                <FeaturedStrip items={featuredCommunityModels} />
              </div>
            )}
            {!loading && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-1.5 h-12 rounded-full border border-slate-200 bg-white px-6 min-w-36 text-sm font-medium text-slate-700 shadow-sm transition-all hover:-translate-y-px hover:border-[#f44336]/30 hover:bg-red-50 hover:text-[#f44336]"
                  onClick={() => navigate("/community")}
                >
                  <Users className="h-5 w-5" />
                  View Community Models
                </button>
              </div>
            )}
          </section>

          <HowItWorks />
          <RealLifeBuilds />
          </ScrollRevealContent>}
        </main>

        {lowerContentReady && <ScrollRevealContent>
          <div className="landing-fade-in"><SiteFooter /></div>
        </ScrollRevealContent>}
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      icon: MessageSquare,
      title: "Describe or upload",
      description: "Type a prompt like \"a pink elephant\" or drop in any image you want to build.",
    },
    {
      icon: Wand2,
      title: "BrickBuilder generates your model",
      description: "Our generative pipeline turns your idea into a buildable 3D brick model in seconds.",
    },
    {
      icon: Package,
      title: "Preview, edit, and order",
      description: "Make your edits, grab the instructions, and we'll ship the parts to your door in 8 days.",
    },
  ];

  return (
    <section
      id="how-it-works"
      className="w-full mt-10 mb-16 relative"
      style={{ zIndex: 15 }}
    >
      <div className="mx-auto max-w-5xl px-2">
        <div className="text-center landing-fade-in landing-delay-1">
          {/* <span className="inline-block rounded-full bg-slate-100 px-3 py-1 text-xs font-medium tracking-wide text-slate-600 uppercase">
            How it works
          </span> */}
          <h2 className="mt-4 text-3xl font-bold text-slate-900 sm:text-4xl">
            How It Works
          </h2>
          <p className="mt-3 text-base text-slate-600 max-w-2xl mx-auto">
            Turn images and text into custom 3D brick models. Edit freely, get instant instructions, and have the parts on your doorstep in 8 days.
          </p>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-8 relative">
          {/* Connecting line behind cards on md+ */}
          <div
            aria-hidden
            className="hidden md:block absolute left-0 right-0 top-12 h-px bg-gradient-to-r from-transparent via-slate-200 to-transparent"
          />

          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <div
                key={step.title}
                className={`relative flex flex-col items-center text-center rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-sm p-6 shadow-sm hover:shadow-md hover:-translate-y-1 transition-all duration-300 landing-fade-in landing-delay-${i + 2}`}
              >
                <div className="relative">
                  <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#f44336] to-[#ff6b6b] text-white shadow-md">
                    <Icon className="h-7 w-7" />
                  </div>
                  <span className="absolute -top-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-white border border-slate-200 text-xs font-bold text-slate-700 shadow-sm">
                    {i + 1}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-slate-900">
                  {step.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  {step.description}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function RealLifeBuilds() {
  return (
    <section className="w-full mb-16 relative" style={{ zIndex: 15 }}>
      <div className="mx-auto max-w-5xl px-2 text-center landing-fade-in landing-delay-1">
        <h2 className="text-3xl font-bold text-slate-900 sm:text-4xl">
          Build It In Real Life
        </h2>
        <p className="mt-3 text-base text-slate-600 max-w-2xl mx-auto">
          Every model comes with real, orderable LEGO parts and instructions. Here's a display of
          BrickBuilder AI creations physically built at the Brickworld Chicago LEGO convention.
        </p>
        <img
          src="/assets/blog/brickworld26/brickbuilderai-models.jpg"
          alt="BrickBuilder AI models built with real LEGO bricks, on display at the Brickworld Chicago LEGO convention"
          className="mt-8 w-full rounded-2xl border border-slate-200 shadow-sm"
        />
      </div>
    </section>
  );
}

function LandingHeader({ onLoginClick }: { onLoginClick: () => void }) {
  const navigate = useNavigate();
  const { user, isSupabaseConfigured } = useAuth();
  const [githubStars, setGithubStars] = useState<number | null>(null);

  // Show profile menu if user is logged in OR if Supabase is not configured
  const showProfileMenu = user || !isSupabaseConfigured;

  useEffect(() => {
    let cancelled = false;

    fetch("https://api.github.com/repos/jjohnson5253/brickbuilderai", {
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
      href="https://github.com/jjohnson5253/brickbuilderai"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="View BrickBuilder on GitHub"
      className="inline-flex h-8 min-w-[4.5rem] items-center justify-center gap-1.5 rounded-full bg-slate-100 px-2 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-200 sm:h-9 sm:min-w-[5.25rem] sm:gap-2 sm:px-3 sm:text-sm"
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

      <nav className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 sm:flex">
        <button
          className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
          onClick={() => navigate("/glb-to-lego")}
        >
          <Box className="h-4 w-4" />
          GLB to LEGO
        </button>
        <button
          className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
          onClick={() => navigate("/community")}
        >
          <Users className="h-4 w-4" />
          Community
        </button>
      </nav>

      {/* Login / Sign Up OR Account Menu */}
      <div className="flex items-center gap-2 sm:gap-3">
        {showProfileMenu ? (
          // Logged in or no Supabase: show GitHub stars and account dropdown
          <>
            {githubStarLink}

            {/* Dashboard button */}
            <button
              className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-2 h-8 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px sm:px-3 sm:h-9"
              onClick={() => navigate('/dashboard')}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>

            {/* Account dropdown */}
            <ProfileMenu />
          </>
        ) : (
          // Not logged in: show login button
          <>
            {githubStarLink}
            <button
              className="h-8 rounded-full border-none bg-[#f44336] px-3 text-xs font-medium text-white cursor-pointer transition-all duration-200 hover:-translate-y-px hover:bg-[#ff6b6b] sm:h-9 sm:px-4 sm:text-sm"
              onClick={onLoginClick}
            >
              Sign up
            </button>
          </>
        )}
        {!showProfileMenu && <NotificationMenu />}
      </div>

    </header>
  );
}

export const FeaturedStrip = memo(function FeaturedStrip({ items }: { items: FeaturedItem[] }) {
  const navigate = useNavigate();
  const trackRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const positionRef = useRef(0);
  const pausedRef = useRef(false);
  const [copyCount, setCopyCount] = useState(2);
  // Fill even a short list before duplicating it for a seamless loop.
  const loopItems = items.length > 0
    ? Array.from({ length: Math.ceil(8 / items.length) * items.length }, (_, index) => items[index % items.length])
    : [];

  const move = (distance: number) => {
    const track = trackRef.current;
    const width = track?.firstElementChild?.getBoundingClientRect().width || 0;
    if (!track || !width) return;
    positionRef.current = ((positionRef.current + distance) % width + width) % width;
    track.style.transform = `translate3d(${-positionRef.current}px, 0, 0)`;
  };

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track || !items.length) return;
    const centerFirstModel = () => {
      const loopWidth = track.firstElementChild?.getBoundingClientRect().width || 0;
      const cardWidth = track.querySelector('article')?.getBoundingClientRect().width || 0;
      if (!loopWidth || !cardWidth) return;
      const viewportWidth = viewport.getBoundingClientRect().width;
      // Movement can consume one full copy. Keep enough copies after it to
      // cover the viewport, including wide displays and browser zoom changes.
      setCopyCount(Math.max(2, Math.ceil(viewportWidth / loopWidth) + 1));
      positionRef.current = 0;
      move(loopWidth - (viewportWidth - cardWidth) / 2);
    };
    centerFirstModel();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(centerFirstModel) : null;
    observer?.observe(viewport);
    if (track.firstElementChild) observer?.observe(track.firstElementChild);
    return () => observer?.disconnect();
  }, [items]);

  useEffect(() => {
    let frame: number;
    let previous = 0;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const step = (time: number) => {
      if (previous && !pausedRef.current && !reducedMotion?.matches) {
        move(37 * Math.min((time - previous) / 1000, 0.1));
      }
      previous = time;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [items]);

  const handleScroll = (direction: 'left' | 'right') => {
    const cardWidth = trackRef.current?.querySelector('article')?.getBoundingClientRect().width || 160;
    move((direction === 'left' ? -1 : 1) * (cardWidth + 24));
    posthog.capture('landing_featured_models_arrow_clicked', {
      direction, item_count: items.length, surface: 'landing_featured_models',
    });
  };

  return (
    <div className="relative w-full select-none"
      onMouseEnter={() => { pausedRef.current = true; }}
      onMouseLeave={() => { pausedRef.current = false; }}
      onFocus={() => { pausedRef.current = true; }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) pausedRef.current = false;
      }}>
      <button type="button" aria-label="Scroll community models left"
        onClick={() => handleScroll('left')} disabled={items.length < 2}
        className="absolute left-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-md disabled:opacity-40">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <div ref={viewportRef} className="overflow-hidden">
        <div ref={trackRef} data-featured-track className="flex w-max" style={{ willChange: 'transform' }}>
          {Array.from({ length: copyCount }, (_, copy) => (
            <div key={copy} data-featured-copy={copy} className="flex w-max shrink-0 gap-6 py-1 pr-6">
              {loopItems.map((item, index) => (
                  <article
                    key={`${item.id}-${index}`}
                    className="shrink-0 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm"
                    style={{ width: "clamp(7.5rem, 13.5vw, 12.75rem)" }}
                  >
                    <div
                      className="relative w-full overflow-hidden rounded-xl bg-slate-50"
                      style={{ paddingTop: "100%" }}
                    >
                      {item.imageUrl ? (
                        <img
                          src={item.imageUrl}
                          alt={item.title}
                          className="absolute left-0 top-0 h-full w-full object-contain"
                          draggable="false"
                          onDragStart={(e) => e.preventDefault()}
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-slate-300">
                          <Sparkles className="h-10 w-10" />
                        </div>
                      )}
                    </div>
                    <div className="mt-3 text-center">
                      <h3 className="text-sm font-semibold text-slate-800 mb-1 line-clamp-2">{item.title}</h3>
                      <button
                        onClick={() => navigate(`/generated-model?id=${item.id}`)}
                        className="mt-1 inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 h-9 text-xs hover:bg-slate-50 cursor-pointer"
                      >
                        <Eye className="w-4 h-4"/> View Model
                      </button>
                    </div>
                  </article>
              ))}
            </div>
          ))}
        </div>
      </div>
      <button type="button" aria-label="Scroll community models right"
        onClick={() => handleScroll('right')} disabled={items.length < 2}
        className="absolute right-2 top-1/2 z-10 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-md disabled:opacity-40">
        <ChevronRight className="h-5 w-5" />
      </button>
    </div>
  );
});
