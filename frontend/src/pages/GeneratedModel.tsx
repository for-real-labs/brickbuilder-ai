import React, { useState } from "react";
import { SEO } from "../components/SEO";
import { SiteFooter } from "../components/SiteFooter";
import { ProfileMenu } from "../components/ProfileMenu";
import { useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { ThreeLDRViewer } from "../components/ThreeLDRViewer";
import type { ExportCaptureApi } from "../components/ThreeLDRViewer";
import { VoxelViewer } from "../components/VoxelViewer";
import LoginModal from "../components/LoginModal";
import modelsMetadata from "../assets/demo-images/models-metadata.json";

const DEMO_MODEL_IDS = new Set(
  Object.values(modelsMetadata).map((m) => m.id)
);

// When running against the local database, generations created on the live
// hosted site won't exist locally. In that case we offer a link to view the
// generation on the live deployment instead.
const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const IS_LOCAL_API = API_MODE === 'local';
const LIVE_SITE_URL = 'https://trybrickbuilder.com';

// Mirrors the backend /updateUsername validation: 3-30 chars,
// letters, numbers, underscores, hyphens, or periods.
const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
type PendingExitAction = () => void | Promise<void>;
import { GetPriceApiService, GetPriceResponse } from "../services/getPriceApi";
import { ResizeScaler } from "../components/ResizeScaler";
import { ResizeModelApiService } from "../services/resizeModelApi";
import { PromptEditModelApiService } from "../services/promptEditModelApi";
import { GetGenerationApiService, GetGenerationResponse } from "../services/getGenerationApi";
import { GetGenerationsByImageApiService, GenerationIteration } from "../services/getGenerationsByImageApi";
import { LdrToMpdApiService } from "../services/ldrToMpdApi";
import { ToggleIsCommunityApiService } from "../services/toggleIsCommunityApi";
import { GetGenerationLikeStatusApiService } from "../services/getGenerationLikeStatusApi";
import { ToggleGenerationLikeApiService } from "../services/toggleGenerationLikeApi";
import { ClaimGenerationApiService } from "../services/claimGenerationApi";
import { UpdateModelApiService, UpdateModelResponse } from "../services/updateModelApi";
import { recordAnonymousGeneration } from "../utils/anonGenerations";
import { getGeneratedModelPath } from "../utils/generationRoutes";
import { ModelEditControls } from "../components/ModelEditControls";
import { StatCard } from "../components/StatCard";
import { UpdateGenerationNameApiService } from "../services/updateGenerationNameApi";
import { UpdateImagePreviewApiService } from "../services/updateImagePreviewApi";
import { supabase } from "../lib/supabase";
import posthog from "posthog-js";
import { useAuth } from "../contexts/AuthContext";
import {
  HandCoins,
  Package,
  Hammer,
  Mail,
  Boxes,
  Star,
  Heart,
  Loader2,
  Pencil,
  Users,
  Github,
  ArrowLeft,
  Download,
  Image,
  FileText,
  Video,
  BookOpen,
  ShoppingCart,
  X,
  LayoutDashboard,
  History,
  ChevronUp,
  Calendar,
  Clock,
  Eye,
} from "lucide-react";

interface HeaderProps {
  onGuardedNavigate: (path: string) => void;
}

function Header({ onGuardedNavigate }: HeaderProps) {
  const navigate = useNavigate();
  const { user, isSupabaseConfigured } = useAuth();
  const [githubStars, setGithubStars] = useState<number | null>(null);

  // Show profile menu if user is logged in OR if Supabase is not configured
  const showProfileMenu = user || !isSupabaseConfigured;

  React.useEffect(() => {
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
    <header className="flex items-center justify-between w-full relative landing-fade-in landing-delay-1" style={{ zIndex: 50 }}>
      <a href="/" className="flex items-center gap-3">
        <img
          src="/logo.svg"
          alt="BrickBuilder"
          className="h-7 w-auto"
          onError={(e) => ((e.currentTarget as HTMLImageElement).style.display = "none")}
        />
        <span className="text-xl font-extrabold tracking-tight">
          <span className="text-[#ff4b4b]">BRICK</span>
          <span className="text-slate-900">BUILDER</span>
        </span>
      </a>

      {/* Login / Sign Up OR Account Menu */}
      <div className="flex items-center gap-3">
        <button
          className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
          onClick={() => onGuardedNavigate("/community")}
        >
          <Users className="h-4 w-4" />
          Community
        </button>
        {githubStarLink}
        {showProfileMenu ? (
          // Logged in or no Supabase: show account dropdown
          <>
            {/* Dashboard button */}
            <button
              className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
              onClick={() => onGuardedNavigate('/dashboard')}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>

            {/* Account dropdown */}
            <ProfileMenu onNavigate={onGuardedNavigate} />
          </>
        ) : (
          // Not logged in: show login/signup buttons
          <>
            <button
              className="bg-transparent text-slate-600 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-black hover:-translate-y-px"
              onClick={() => navigate("/login")}
            >
              Login
            </button>

            <button
              className="bg-[#f44336] text-white rounded-full px-4 h-9 border-none text-sm font-medium cursor-pointer transition-all duration-200 hover:bg-[#ff6b6b] hover:-translate-y-px"
              onClick={() => navigate("/signup")}
            >
              Sign Up
            </button>
          </>
        )}
      </div>
      
    </header>
  );
}

export default function GeneratedModel() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const params = new URLSearchParams(location.search);
  const { user: currentUser, userProfile: currentUserProfile, updateUsername } = useAuth();
  
  // Generation fetch state
  const [generationLoading, setGenerationLoading] = React.useState(false);
  const [generationError, setGenerationError] = React.useState<string | null>(null);
  const [currentGenerationId, setCurrentGenerationId] = React.useState<string | null>(null);
  const [screenshots, setScreenshots] = React.useState<{ angle1: string; angle2: string } | null>(null);
  const [priceData, setPriceData] = React.useState<GetPriceResponse | null>(null);
  const [priceLoading, setPriceLoading] = React.useState(false);
  const [priceError, setPriceError] = React.useState<string | null>(null);
  const [priceRefreshCounter, setPriceRefreshCounter] = React.useState(0);
  const [isResizing, setIsResizing] = React.useState(false);
  const [showResizeScaler, setShowResizeScaler] = React.useState(false);
  const [showPriceResize, setShowPriceResize] = React.useState(false);
  const [isPromptEditing, setIsPromptEditing] = React.useState(false);
  const [editPrompt, setEditPrompt] = React.useState("");
  const [editModelQuality, setEditModelQuality] = React.useState<"regular" | "premium">("premium");
  const [editPreviewImageUrl, setEditPreviewImageUrl] = React.useState<string | null>(null);
  const [editPromptError, setEditPromptError] = React.useState<string | null>(null);
  
  // Voxel editor state
  const [showVoxelEditor, setShowVoxelEditor] = React.useState(false);
  const [voxelHasChanges, setVoxelHasChanges] = React.useState(false);
  const [showUnsavedChangesModal, setShowUnsavedChangesModal] = React.useState(false);
  // Action to perform after the user resolves the unsaved-changes modal
  // (Save or Discard). Defaults to simply exiting the editor.
  const pendingExitActionRef = React.useRef<PendingExitAction | null>(null);
  const voxelSaveRef = React.useRef<(() => Promise<void>) | null>(null);
  // Captures a PNG preview straight from the voxel editor scene after a save,
  // so the user can stay in the editor (no need to exit to the 3D viewer).
  const voxelCapturePreviewRef = React.useRef<(() => string | null) | null>(null);
  const [xyzrgbContent, setXyzrgbContent] = React.useState<string | null>(null);
  const [xyzrgbUrl, setXyzrgbUrl] = React.useState<string | null>(null);
  const [problematicXyzrgbContent, setProblematicXyzrgbContent] = React.useState<string | null>(null);
  const [problematicXyzrgbUrl, setProblematicXyzrgbUrl] = React.useState<string | null>(null);
  const [xyzrgbLoading, setXyzrgbLoading] = React.useState(false);
  const [xyzrgbError, setXyzrgbError] = React.useState<string | null>(null);
  const [accessToken, setAccessToken] = React.useState<string | null>(null);
  const [processedImageUrl, setProcessedImageUrl] = React.useState<string | null>(null);
  const [currentScaler, setCurrentScaler] = React.useState<number | undefined>(undefined);
  
  // State for reactive model content
  const [mpdContent, setMpdContent] = React.useState<string | null>(null);
  const [ldrContent, setLdrContent] = React.useState<string | null>(null);
  const [modelName, setModelName] = React.useState<string>("Your Model");
  
  // Save polling state (after VoxelViewer save, poll until LDR processing completes)
  const [isSavePolling, setIsSavePolling] = React.useState(false);
  const [savePollingError, setSavePollingError] = React.useState<string | null>(null);
  const savePollingAbortRef = React.useRef<AbortController | null>(null);

  // Community toggle state
  const [isCommunity, setIsCommunity] = React.useState<boolean>(false);
  const [generationOwnerId, setGenerationOwnerId] = React.useState<string | null>(null);
  const [communityToggleLoading, setCommunityToggleLoading] = React.useState<boolean>(false);
  const [communityToggleError, setCommunityToggleError] = React.useState<string | null>(null);
  const [likeCount, setLikeCount] = React.useState<number>(0);
  const [hasLikedCommunityModel, setHasLikedCommunityModel] = React.useState<boolean>(false);
  const [likeToggleLoading, setLikeToggleLoading] = React.useState<boolean>(false);
  // Login modal shown when a logged-out user tries to post to community
  const [showLoginModal, setShowLoginModal] = React.useState<boolean>(false);
  // Set when a logged-out user clicks "Post to Community" so the posting flow
  // can resume automatically once they finish logging in.
  const [pendingCommunityPost, setPendingCommunityPost] = React.useState<boolean>(false);
  const [pendingLikeAfterLogin, setPendingLikeAfterLogin] = React.useState<boolean>(false);
  // Naming modal (shown when posting to community)
  const [showCommunityNameModal, setShowCommunityNameModal] = React.useState<boolean>(false);
  const [communityNameInput, setCommunityNameInput] = React.useState<string>("");
  const [communityNameError, setCommunityNameError] = React.useState<string | null>(null);
  // Username editing within the community modal
  const [isEditingUsername, setIsEditingUsername] = React.useState<boolean>(false);
  const [usernameInput, setUsernameInput] = React.useState<string>("");
  const [usernameSaving, setUsernameSaving] = React.useState<boolean>(false);
  const [usernameError, setUsernameError] = React.useState<string | null>(null);

  // Whether the current generation is missing a preview image and should have
  // one captured + uploaded after the 3D viewer finishes loading.
  const [needsPreviewUpload, setNeedsPreviewUpload] = React.useState<boolean>(false);
  // Tracks generation ids we've already uploaded a preview for in this session
  // so we don't re-upload on every viewer re-render.
  const previewUploadedForRef = React.useRef<Set<string>>(new Set());

  // True once the Three.js scene has finished loading the model. Used to fade
  // in the sections below the 3D preview only after the scene is ready.
  const [sceneReady, setSceneReady] = React.useState<boolean>(false);

  const [previewPngDataUrl, setPreviewPngDataUrl] = React.useState<string | null>(null);
  const previewUploadWaitersRef = React.useRef<Map<string, Array<{ resolve: () => void; reject: (error: unknown) => void }>>>(new Map());
  const activeSavePreviewUploadRef = React.useRef<Promise<void> | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = React.useState(false);
  const [isExportingVideo, setIsExportingVideo] = React.useState(false);
  const exportCaptureApiRef = React.useRef<ExportCaptureApi | null>(null);
  const exportMenuRef = React.useRef<HTMLDivElement | null>(null);
  const [editHistoryOpen, setEditHistoryOpen] = React.useState(false);
  const [editHistory, setEditHistory] = React.useState<GenerationIteration[]>([]);
  const [editHistoryLoading, setEditHistoryLoading] = React.useState(false);
  const [editHistoryError, setEditHistoryError] = React.useState<string | null>(null);
  const editHistoryMenuRef = React.useRef<HTMLDivElement | null>(null);

  const handleExportCaptureReady = React.useCallback((api: ExportCaptureApi | null) => {
    exportCaptureApiRef.current = api;
  }, []);

  // Only the owner of the generation (when logged in) can post / unpost to community
  const canToggleCommunity = Boolean(
    currentUser?.id && generationOwnerId && currentUser.id === generationOwnerId
  );
  // Show the community button to the owner, or to any logged-out visitor (who
  // will be prompted to log in when they click it). Also keep it visible while
  // a post is pending right after login so it doesn't flicker out mid-flow.
  const canShowCommunityButton = canToggleCommunity || !currentUser || pendingCommunityPost;
  
  // Get model data from location state (passed from LandingPage) or localStorage
  const stateData = location.state as { 
    mpdContent?: string,
    ldrContent?: string,
    modelName?: string,
    voxelSize?: number,
    generation_id?: string,
    storageKeys?: {
      LDR_CONTENT: string,
      MPD_CONTENT: string,
      MODEL_NAME: string,
      GENERATED_AT: string,
      GENERATION_ID: string
    }
  } | null;

  const isDemoModel = !!currentGenerationId && DEMO_MODEL_IDS.has(currentGenerationId);
  
  // Function to load model data from various sources
  const getModelData = () => {
    if (stateData?.mpdContent && stateData?.ldrContent) {
      return {
        mpdContent: stateData.mpdContent,
        ldrContent: stateData.ldrContent,
        modelName: stateData.modelName || "Your Model"
      };
    }
    
    // Fallback to localStorage using passed storage keys
    if (stateData?.storageKeys) {
      try {
        const storageKeys = stateData.storageKeys;
        const savedMpdContent = localStorage.getItem(storageKeys.MPD_CONTENT);
        const savedLdrContent = localStorage.getItem(storageKeys.LDR_CONTENT);
        const savedModelName = localStorage.getItem(storageKeys.MODEL_NAME);
        
        return {
          mpdContent: savedMpdContent,
          ldrContent: savedLdrContent,
          modelName: savedModelName || params.get("name") || "Your Model"
        };
      } catch (error) {
        console.error('Error loading model');
      }
    }
    
    // Additional fallback: try standard localStorage keys when no storageKeys provided
    try {
      const savedMpdContent = localStorage.getItem('lastMpdContent');
      const savedLdrContent = localStorage.getItem('lastLdrContent');
      const savedModelName = localStorage.getItem('lastModelName');
      
      if (savedMpdContent) {
        return {
          mpdContent: savedMpdContent,
          ldrContent: savedLdrContent,
          modelName: savedModelName || params.get("name") || "Your Model"
        };
      }
    } catch (error) {
      console.error('Error loading model');
    }
    
    // Final fallback
    return {
      mpdContent: null,
      ldrContent: null,
      modelName: params.get("name") || "Your Model"
    };
  };
  
  // Initialize model data on component mount - check URL id param first, then fetch from backend, fall back to localStorage
  React.useEffect(() => {
    const initializeModelData = async () => {
      // Priority 1: Check for id parameter in URL (e.g., /generated-model?id=abc123)
      const urlGenerationId = searchParams.get('id');
      
      if (urlGenerationId) {
        setGenerationLoading(true);
        setGenerationError(null);
        
        try {
          // First check the current status
          const statusResponse = await GetGenerationApiService.getGeneration(urlGenerationId);
          
          // If still processing, poll until complete
          if (statusResponse.status === 'started' || statusResponse.status === 'processing') {
            // Show preview image if available
            if (statusResponse.external_image_url) {
              setEditPreviewImageUrl(statusResponse.external_image_url);
            }
            
            // Poll until complete
            const generationData = await GetGenerationApiService.pollUntilComplete(
              urlGenerationId,
              (response: GetGenerationResponse) => {
                if (response.external_image_url) {
                  setEditPreviewImageUrl(response.external_image_url);
                }
                if (response.processed_image_url) {
                  setProcessedImageUrl(response.processed_image_url);
                }
              }
            );
            
            // Clear preview image after completion
            setEditPreviewImageUrl(null);
            
            // Process completed generation
            await processCompletedGeneration(urlGenerationId, generationData);
            return;
          }
          
          // If failed, show error
          if (statusResponse.status === 'failed') {
            throw new Error(statusResponse.error_message || 'Generation failed');
          }
          
          // If completed, use the data directly
          if (statusResponse.status === 'completed') {
            if (!statusResponse.ldr_content) {
              throw new Error('No LDR content found in generation data');
            }
            
            // Set reference image URL for voxel editor
            if (statusResponse.processed_image_url) {
              setProcessedImageUrl(statusResponse.processed_image_url);
            }
            
            // Set detail level for resize scaler
            if (statusResponse.detail_level) {
              setCurrentScaler(statusResponse.detail_level);
            }
            
            await processCompletedGeneration(urlGenerationId, {
              generation_id: statusResponse.generation_id,
              prompt: statusResponse.prompt || 'Your Model',
              ldr_content: statusResponse.ldr_content,
              mpd_url: statusResponse.mpd_url,
              xyzrgb_url: statusResponse.xyzrgb_url,
              problematic_xyzrgb_url: statusResponse.problematic_xyzrgb_url,
            });
            return;
          }
          
        } catch (error) {
          console.error('Failed to fetch generation data from URL id:', error);
          setGenerationError(`Failed to load generation: ${error instanceof Error ? error.message : 'Unknown error'}`);
          setGenerationLoading(false);
          return;
        }
      }
      
      // Priority 2: Check for generation_id in location state (passed from LandingPage navigation)
      const stateGenerationId = stateData?.generation_id;
      
      if (stateGenerationId) {
        setGenerationLoading(true);
        setGenerationError(null);
        
        try {
          const statusResponse = await GetGenerationApiService.getGeneration(stateGenerationId);
          
          if (statusResponse.status === 'completed' && statusResponse.ldr_content) {
            if (statusResponse.processed_image_url) {
              setProcessedImageUrl(statusResponse.processed_image_url);
            }
            await processCompletedGeneration(stateGenerationId, {
              generation_id: statusResponse.generation_id,
              prompt: statusResponse.prompt || stateData?.modelName || 'Your Model',
              ldr_content: statusResponse.ldr_content,
              mpd_url: statusResponse.mpd_url,
              xyzrgb_url: statusResponse.xyzrgb_url,
              problematic_xyzrgb_url: statusResponse.problematic_xyzrgb_url,
            });
            return;
          }
          
          if (statusResponse.status === 'failed') {
            throw new Error(statusResponse.error_message || 'Generation failed');
          }
        } catch (error) {
          console.error('Failed to fetch generation data from state:', error);
          setGenerationError(`Failed to load generation: ${error instanceof Error ? error.message : 'Unknown error'}`);
          setGenerationLoading(false);
          return;
        }
      }
      
      // Priority 3: Try localStorage generation ID
      const generationId = localStorage.getItem('lastGenerationId');
      
      // Try to fetch latest data from backend first
      if (generationId) {
        try {
          const statusResponse = await GetGenerationApiService.getGeneration(generationId);
          
          // If completed, use the data
          if (statusResponse.status === 'completed' && statusResponse.ldr_content) {
            // Store generation ID for edit mode
            setCurrentGenerationId(generationId);
            
            // Set reference image URL for voxel editor
            if (statusResponse.processed_image_url) {
              setProcessedImageUrl(statusResponse.processed_image_url);
            }
            
            // Update detail level for resize scaler
            if (statusResponse.detail_level) {
              setCurrentScaler(statusResponse.detail_level);
            }
            
            // Update xyzrgb URL if available
            if (statusResponse.xyzrgb_url) {
              setXyzrgbUrl(statusResponse.xyzrgb_url);
            }
            
            // Update problematic xyzrgb URL if available
            if (statusResponse.problematic_xyzrgb_url) {
              setProblematicXyzrgbUrl(statusResponse.problematic_xyzrgb_url);
            }
            
            // Update LDR content
            localStorage.setItem('lastLdrContent', statusResponse.ldr_content);
            setLdrContent(statusResponse.ldr_content);
            
            // Set model name from backend prompt
            const freshModelName = statusResponse.prompt || localStorage.getItem('lastModelName') || "Your Model";
            setModelName(freshModelName);
            localStorage.setItem('lastModelName', freshModelName);
            
            // Get MPD content from URL or convert LDR to MPD
            let mpdContent: string | null = null;
            if (statusResponse.mpd_url) {
              try {
                const mpdResponse = await fetch(statusResponse.mpd_url);
                if (mpdResponse.ok) {
                  mpdContent = await mpdResponse.text();
                }
              } catch (mpdError) {
                console.warn('Failed to fetch MPD from URL:', mpdError);
              }
            }
            
            if (!mpdContent) {
              try {
                const authToken = (await supabase.auth.getSession()).data.session?.access_token;
                const mpdData = await LdrToMpdApiService.convertLdrToMpd(
                  statusResponse.ldr_content,
                  freshModelName,
                  authToken
                );
                mpdContent = mpdData.mpd_content;
              } catch (mpdError) {
                console.warn('Failed to convert LDR to MPD:', mpdError);
              }
            }
            
            if (mpdContent) {
              localStorage.setItem('lastMpdContent', mpdContent);
              setMpdContent(mpdContent);
            }
            
            return; // Successfully loaded from backend
          }
        } catch (error) {
          console.error('Failed to fetch generation data, falling back to localStorage:', error);
        }
      }
      
      // Priority 3: Fall back to localStorage if backend fetch fails or no generation ID
      const { mpdContent: initialMpdContent, ldrContent: initialLdrContent, modelName: initialName } = getModelData();
      if (initialMpdContent) setMpdContent(initialMpdContent);
      if (initialLdrContent) setLdrContent(initialLdrContent);
      setModelName(initialName);
    };
    
    // Helper function to process completed generation data
    const processCompletedGeneration = async (
      generationId: string,
      data: { 
        generation_id: string; 
        prompt: string; 
        ldr_content: string; 
        mpd_url: string | null;
        xyzrgb_url: string | null; 
        problematic_xyzrgb_url: string | null;
      }
    ) => {
      // Store generation ID for edit mode
      setCurrentGenerationId(generationId);
      
      // Update xyzrgb URL if available
      if (data.xyzrgb_url) {
        setXyzrgbUrl(data.xyzrgb_url);
      }
      
      // Update problematic xyzrgb URL if available
      if (data.problematic_xyzrgb_url) {
        setProblematicXyzrgbUrl(data.problematic_xyzrgb_url);
      }
      
      // Set LDR content
      setLdrContent(data.ldr_content);
      
      // Set model name from prompt
      const fetchedModelName = data.prompt || "Your Model";
      setModelName(fetchedModelName);
      
      // Get MPD content from URL or convert LDR to MPD
      let mpdContent: string | null = null;
      if (data.mpd_url) {
        try {
          const mpdResponse = await fetch(data.mpd_url);
          if (mpdResponse.ok) {
            mpdContent = await mpdResponse.text();
          }
        } catch (mpdError) {
          console.warn('Failed to fetch MPD from URL:', mpdError);
        }
      }
      
      if (!mpdContent) {
        try {
          const authToken = (await supabase.auth.getSession()).data.session?.access_token;
          const mpdData = await LdrToMpdApiService.convertLdrToMpd(
            data.ldr_content,
            fetchedModelName,
            authToken
          );
          mpdContent = mpdData.mpd_content;
        } catch (mpdError) {
          console.warn('Failed to convert LDR to MPD:', mpdError);
        }
      }
      
      if (mpdContent) {
        setMpdContent(mpdContent);
      }
      
      setGenerationLoading(false);
    };
    
    initializeModelData();
  }, [searchParams]);
  
  // Fetch access token on mount
  React.useEffect(() => {
    const fetchToken = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        setAccessToken(session?.access_token || null);
      } catch (error) {
        console.error('Failed to get session token:', error);
      }
    };
    fetchToken();
  }, []);

  // Fetch isCommunity flag for the current generation
  React.useEffect(() => {
    let cancelled = false;

    const fetchIsCommunity = async () => {
      if (!currentGenerationId) {
        setIsCommunity(false);
        setGenerationOwnerId(null);
        setNeedsPreviewUpload(false);
        return;
      }
      try {
        const { data, error } = await supabase
          .from('generations')
          .select('is_community, user_id, preview_image_url')
          .eq('id', currentGenerationId)
          .maybeSingle();

        if (cancelled) return;

        if (error) {
          console.warn('Failed to fetch is_community flag:', error);
          return;
        }

        const row = data as {
          is_community?: boolean;
          user_id?: string | null;
          preview_image_url?: string | null;
        } | null;
        setIsCommunity(Boolean(row?.is_community));
        setGenerationOwnerId(row?.user_id ?? null);
        setNeedsPreviewUpload(!row?.preview_image_url);
      } catch (e) {
        if (!cancelled) {
          console.warn('Failed to fetch is_community flag:', e);
        }
      }
    };

    fetchIsCommunity();
    return () => {
      cancelled = true;
    };
  }, [currentGenerationId]);

  React.useEffect(() => {
    let cancelled = false;

    const fetchLikeStatus = async () => {
      if (!currentGenerationId) {
        setLikeCount(0);
        setHasLikedCommunityModel(false);
        return;
      }

      try {
        const response = await GetGenerationLikeStatusApiService.getGenerationLikeStatus(
          currentGenerationId,
          accessToken || undefined,
        );
        if (cancelled) return;
        setIsCommunity(response.is_community);
        setLikeCount(response.like_count);
        setHasLikedCommunityModel(response.viewer_has_liked);
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to fetch generation like status:', error);
        }
      }
    };

    void fetchLikeStatus();
    return () => {
      cancelled = true;
    };
  }, [accessToken, currentGenerationId, currentUser?.id]);

  // Whether the signed-in user owns the current generation. Required to
  // upload a preview image (and matches the backend's authorization check).
  const isGenerationOwner = Boolean(
    currentUser?.id && generationOwnerId && currentUser.id === generationOwnerId
  );

  // Called once after ThreeLDRViewer finishes loading the model. Stores the
  // captured PNG so the upload effect below can send it once all async state
  // (auth token, generation ownership, needsPreviewUpload) has resolved.
  const handlePreviewCaptured = React.useCallback((dataUrl: string) => {
    setPreviewPngDataUrl(dataUrl);
  }, []);

  const rejectPreviewUploadWaiters = React.useCallback((generationId: string, error: unknown) => {
    const waiters = previewUploadWaitersRef.current.get(generationId);
    if (!waiters) return;
    previewUploadWaitersRef.current.delete(generationId);
    waiters.forEach(({ reject }) => reject(error));
  }, []);

  const uploadPreviewImage = React.useCallback(async (
    generationId: string,
    imageDataUrl: string,
    token: string,
  ) => {
    if (previewUploadedForRef.current.has(generationId)) return;

    previewUploadedForRef.current.add(generationId);
    try {
      await UpdateImagePreviewApiService.updateImagePreview(
        generationId,
        imageDataUrl,
        token,
      );
      const waiters = previewUploadWaitersRef.current.get(generationId);
      if (waiters) {
        previewUploadWaitersRef.current.delete(generationId);
        waiters.forEach(({ resolve }) => resolve());
      }
      setNeedsPreviewUpload(false);
    } catch (err) {
      previewUploadedForRef.current.delete(generationId);
      rejectPreviewUploadWaiters(generationId, err);
      throw err;
    }
  }, [rejectPreviewUploadWaiters]);

  const waitForPreviewUpload = React.useCallback((generationId: string) => new Promise<void>((resolve, reject) => {
    if (previewUploadedForRef.current.has(generationId)) {
      resolve();
      return;
    }

    const waiters = previewUploadWaitersRef.current.get(generationId) ?? [];
    waiters.push({ resolve, reject });
    previewUploadWaitersRef.current.set(generationId, waiters);
  }), []);

  const handleUpdatedModelStarted = React.useCallback(async (
    response: UpdateModelResponse,
    options: { captureVoxelPreview?: boolean; preserveEditorContent?: boolean } = {}
  ) => {
    if (!response.generation_id) {
      throw new Error('No generation ID returned from update');
    }

    localStorage.setItem('lastGenerationId', response.generation_id);
    localStorage.setItem('GENERATION_ID', response.generation_id);
    if (!currentUser) recordAnonymousGeneration(response.generation_id);

    setCurrentGenerationId(response.generation_id);
    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('id', response.generation_id);
    window.history.replaceState({}, '', newUrl.toString());

    if (savePollingAbortRef.current) {
      savePollingAbortRef.current.abort();
    }
    const abortController = new AbortController();
    savePollingAbortRef.current = abortController;

    setIsSavePolling(true);
    setSavePollingError(null);

    try {
      const completedGeneration = await GetGenerationApiService.pollUntilComplete(
        response.generation_id,
        undefined,
        undefined,
        undefined,
        abortController.signal
      );

      console.log('[GeneratedModel] Update polling completed:', completedGeneration.generation_id);

      if (completedGeneration.ldr_content) {
        setLdrContent(completedGeneration.ldr_content);
        localStorage.setItem('LDR_CONTENT', completedGeneration.ldr_content);
        localStorage.setItem('lastLdrContent', completedGeneration.ldr_content);
      }

      let newMpdContent: string | null = null;
      if (completedGeneration.mpd_url) {
        try {
          const mpdResponse = await fetch(completedGeneration.mpd_url);
          if (mpdResponse.ok) {
            newMpdContent = await mpdResponse.text();
          }
        } catch (mpdError) {
          console.warn('Failed to fetch MPD from URL:', mpdError);
        }
      }

      if (!newMpdContent && completedGeneration.ldr_content) {
        try {
          const authToken = (await supabase.auth.getSession()).data.session?.access_token;
          const mpdData = await LdrToMpdApiService.convertLdrToMpd(
            completedGeneration.ldr_content,
            modelName,
            authToken
          );
          newMpdContent = mpdData.mpd_content;
        } catch (mpdError) {
          console.warn('Failed to convert LDR to MPD:', mpdError);
        }
      }

      if (newMpdContent) {
        previewUploadedForRef.current.delete(response.generation_id);
        setNeedsPreviewUpload(true);
        if (options.captureVoxelPreview) {
          activeSavePreviewUploadRef.current = waitForPreviewUpload(response.generation_id).finally(() => {
            activeSavePreviewUploadRef.current = null;
          });
          const voxelPreview = voxelCapturePreviewRef.current?.() ?? null;
          setPreviewPngDataUrl(voxelPreview);
        }
        setMpdContent(newMpdContent);
        localStorage.setItem('MPD_CONTENT', newMpdContent);
        localStorage.setItem('lastMpdContent', newMpdContent);
      }

      if (completedGeneration.xyzrgb_url) {
        setXyzrgbUrl(completedGeneration.xyzrgb_url);

        if (!options.preserveEditorContent || !showVoxelEditor) {
          try {
            const xyzrgbResponse = await fetch(completedGeneration.xyzrgb_url);
            if (xyzrgbResponse.ok) {
              const content = await xyzrgbResponse.text();
              setXyzrgbContent(content);
            }
          } catch (err) {
            console.warn('Failed to fetch xyzrgb content:', err);
          }
        }
      }

      if (completedGeneration.problematic_xyzrgb_url) {
        setProblematicXyzrgbUrl(completedGeneration.problematic_xyzrgb_url);

        try {
          const problematicResponse = await fetch(completedGeneration.problematic_xyzrgb_url);
          if (problematicResponse.ok) {
            const problematicContent = await problematicResponse.text();
            setProblematicXyzrgbContent(problematicContent);
          }
        } catch (problematicErr) {
          console.warn('Failed to fetch problematic xyzrgb content:', problematicErr);
        }
      } else {
        setProblematicXyzrgbUrl(null);
        setProblematicXyzrgbContent(null);
      }

      setScreenshots(null);
      setPriceRefreshCounter(c => c + 1);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        console.log('[GeneratedModel] Update polling aborted (superseded by newer save)');
        return;
      }
      console.error('Update polling failed:', error);
      setSavePollingError(error instanceof Error ? error.message : 'Failed to process model update');
      throw error;
    } finally {
      if (savePollingAbortRef.current === abortController) {
        setIsSavePolling(false);
        savePollingAbortRef.current = null;
      }
    }
  }, [currentUser, modelName, showVoxelEditor, waitForPreviewUpload]);

  // Upload the captured preview image once every required piece of async state
  // is ready. This effect re-runs whenever any dependency changes, so it
  // correctly handles the race where the 3D viewer fires onPreviewCaptured
  // before the auth token or Supabase generation query have returned (e.g.
  // when navigating from the landing page with in-memory model data).
  React.useEffect(() => {
    if (!previewPngDataUrl) return;
    if (!currentGenerationId) return;
    if (!needsPreviewUpload) return;
    if (!isGenerationOwner) return;
    if (!accessToken) return;
    if (previewUploadedForRef.current.has(currentGenerationId)) return;

    uploadPreviewImage(currentGenerationId, previewPngDataUrl, accessToken)
      .catch((err) => {
        console.warn('Failed to upload preview image:', err);
      });
  }, [previewPngDataUrl, currentGenerationId, needsPreviewUpload, isGenerationOwner, accessToken, uploadPreviewImage]);

  React.useEffect(() => {
    if (!exportMenuOpen) return;
    const handleDocumentClick = (event: MouseEvent) => {
      if (!exportMenuRef.current) return;
      if (!exportMenuRef.current.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleDocumentClick);
    return () => document.removeEventListener('mousedown', handleDocumentClick);
  }, [exportMenuOpen]);

  React.useEffect(() => {
    setEditHistoryOpen(false);
    setEditHistory([]);
    setEditHistoryError(null);
  }, [processedImageUrl]);

  React.useEffect(() => {
    if (!editHistoryOpen) return;

    const handleDismiss = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && editHistoryMenuRef.current?.contains(event.target as Node)) return;
      setEditHistoryOpen(false);
    };

    document.addEventListener('mousedown', handleDismiss);
    document.addEventListener('keydown', handleDismiss);
    return () => {
      document.removeEventListener('mousedown', handleDismiss);
      document.removeEventListener('keydown', handleDismiss);
    };
  }, [editHistoryOpen]);

  const handleToggleEditHistory = React.useCallback(async () => {
    if (editHistoryOpen) {
      setEditHistoryOpen(false);
      return;
    }

    setEditHistoryOpen(true);
    if (!processedImageUrl) return;

    setEditHistoryLoading(true);
    setEditHistoryError(null);
    try {
      const response = await GetGenerationsByImageApiService.getGenerationsByImage(
        accessToken || undefined,
        processedImageUrl,
      );
      setEditHistory([...response.generations].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ));
    } catch (error) {
      console.error('Failed to load edit history:', error);
      setEditHistoryError('Could not load edit history. Please try again.');
    } finally {
      setEditHistoryLoading(false);
    }
  }, [accessToken, editHistoryOpen, processedImageUrl]);

  const handleToggleCommunity = async () => {
    if (!currentGenerationId || communityToggleLoading) return;

    // When posting (currently not in community), open the naming modal first.
    // The actual toggle happens after the user submits a name.
    if (!isCommunity) {
      setCommunityToggleLoading(true);
      setCommunityNameError(null);
      setCommunityToggleError(null);
      try {
        await activeSavePreviewUploadRef.current;
        setCommunityNameInput("");
        setIsEditingUsername(false);
        setUsernameError(null);
        setShowCommunityNameModal(true);
      } catch (error) {
        console.error('Failed to upload preview before posting to community:', error);
        setCommunityToggleError(
          error instanceof Error ? error.message : 'Failed to upload preview image'
        );
      } finally {
        setCommunityToggleLoading(false);
      }
      return;
    }

    // Removing from community — no modal, toggle directly.
    setCommunityToggleLoading(true);
    setCommunityToggleError(null);
    const previous = isCommunity;
    setIsCommunity(!previous);
    try {
      const response = await ToggleIsCommunityApiService.toggleIsCommunity(
        currentGenerationId,
        accessToken || undefined
      );
      if (typeof response.is_community === 'boolean') {
        setIsCommunity(response.is_community);
      } else if (typeof response.isCommunity === 'boolean') {
        setIsCommunity(response.isCommunity);
      }
    } catch (error) {
      setIsCommunity(previous);
      console.error('Failed to toggle community status:', error);
      setCommunityToggleError(
        error instanceof Error ? error.message : 'Failed to update community status'
      );
    } finally {
      setCommunityToggleLoading(false);
    }
  };

  const handleToggleCommunityLike = async () => {
    if (!currentGenerationId || likeToggleLoading || !isCommunity) return;

    if (!currentUser) {
      setPendingLikeAfterLogin(true);
      setShowLoginModal(true);
      return;
    }

    const previousLiked = hasLikedCommunityModel;
    const previousLikeCount = likeCount;
    const nextLiked = !previousLiked;

    setLikeToggleLoading(true);
    setHasLikedCommunityModel(nextLiked);
    setLikeCount(Math.max(previousLikeCount + (nextLiked ? 1 : -1), 0));
    setCommunityToggleError(null);

    posthog.capture('community_model_like_clicked', {
      generation_id: currentGenerationId,
      has_liked: nextLiked,
      surface: 'generated_model',
      is_demo_model: isDemoModel,
      is_authenticated: true,
    });

    try {
      const response = await ToggleGenerationLikeApiService.toggleGenerationLike(
        currentGenerationId,
        accessToken || undefined,
      );
      setHasLikedCommunityModel(response.has_liked);
      setLikeCount(response.like_count);
    } catch (error) {
      setHasLikedCommunityModel(previousLiked);
      setLikeCount(previousLikeCount);
      console.error('Failed to toggle generation like:', error);
      setCommunityToggleError(
        error instanceof Error ? error.message : 'Failed to update like'
      );
    } finally {
      setLikeToggleLoading(false);
    }
  };

  // Re-fetch ownership/community flags for the current generation. Used after
  // login so the "Post to Community" button reflects fresh ownership.
  const refreshGenerationOwnership = async () => {
    if (!currentGenerationId) return;
    try {
      const { data } = await supabase
        .from('generations')
        .select('is_community, user_id, preview_image_url')
        .eq('id', currentGenerationId)
        .maybeSingle();
      const row = data as {
        is_community?: boolean;
        user_id?: string | null;
        preview_image_url?: string | null;
      } | null;
      setIsCommunity(Boolean(row?.is_community));
      setGenerationOwnerId(row?.user_id ?? null);
      setNeedsPreviewUpload(!row?.preview_image_url);
    } catch (e) {
      console.warn('Failed to refresh generation ownership:', e);
    }
  };

  // Called after a logged-out visitor finishes signing in via the login modal
  // they opened from the "Post to Community" button. We refresh the session
  // token, claim any anonymous generations created in this session (so the
  // user owns this one), refresh ownership, then resume the posting flow.
  const handleCommunityLoginSuccess = async () => {
    setShowLoginModal(false);
    const shouldResumePost = pendingCommunityPost;
    const shouldResumeLike = pendingLikeAfterLogin;
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token || undefined;
      setAccessToken(token || null);

      // Claim ownership of THIS generation deterministically by id, so the
      // user owns it before we resume posting. This is reliable on
      // mobile/production (no dependency on the anonymous IP hash). Any other
      // generations this browser created while logged out are claimed centrally
      // in AuthContext via the recorded anon-generation ids.
      if (token && currentGenerationId) {
        try {
          await ClaimGenerationApiService.claimGeneration(currentGenerationId, token);
        } catch (e) {
          console.warn('Failed to claim generation after login:', e);
        }
      }

      await refreshGenerationOwnership();

      if (shouldResumePost) {
        void handleToggleCommunity();
      }
      if (shouldResumeLike) {
        void handleToggleCommunityLike();
      }
    } catch (e) {
      console.warn('Failed to finalize community login flow:', e);
    } finally {
      setPendingCommunityPost(false);
      setPendingLikeAfterLogin(false);
    }
  };

  // Username derived for display: profile username, fallback to email local-part.
  const displayUsername = (currentUserProfile?.username && currentUserProfile.username.trim())
    || currentUser?.email?.split('@')[0]
    || 'builder';

  const handleStartEditUsername = () => {
    setUsernameInput(currentUserProfile?.username?.trim() || displayUsername);
    setUsernameError(null);
    setIsEditingUsername(true);
  };

  const handleCancelEditUsername = () => {
    if (usernameSaving) return;
    setIsEditingUsername(false);
    setUsernameInput("");
    setUsernameError(null);
  };

  const handleSaveUsername = async () => {
    if (usernameSaving) return;
    const trimmed = usernameInput.trim();
    if (!trimmed) {
      setUsernameError('Username cannot be empty.');
      return;
    }
    if (trimmed.length < 3 || trimmed.length > 30) {
      setUsernameError('Username must be 3-30 characters.');
      return;
    }
    if (!USERNAME_PATTERN.test(trimmed)) {
      setUsernameError(
        'Username can only contain letters, numbers, underscores, hyphens, or periods.'
      );
      return;
    }
    setUsernameSaving(true);
    setUsernameError(null);
    try {
      const { error, success } = await updateUsername(trimmed);
      if (!success) {
        setUsernameError(typeof error === 'string' ? error : 'Failed to update username.');
        return;
      }
      setIsEditingUsername(false);
      setUsernameInput("");
    } catch (err) {
      setUsernameError(err instanceof Error ? err.message : 'Failed to update username.');
    } finally {
      setUsernameSaving(false);
    }
  };

  const handleSubmitCommunityName = async () => {
    if (!currentGenerationId || communityToggleLoading) return;
    if (isEditingUsername) {
      setCommunityNameError('Please save or cancel your username change first.');
      return;
    }
    const trimmed = communityNameInput.trim();
    if (!trimmed) {
      setCommunityNameError('Please enter a name for your model.');
      return;
    }
    if (trimmed.length > 200) {
      setCommunityNameError('Name must be 200 characters or fewer.');
      return;
    }

    setCommunityToggleLoading(true);
    setCommunityNameError(null);
    setCommunityToggleError(null);
    const previous = isCommunity;

    try {
      // 1) Save the name first
      await UpdateGenerationNameApiService.updateGenerationName(
        currentGenerationId,
        trimmed,
        accessToken || undefined
      );
      // Reflect the new name locally
      setModelName(trimmed);

      // 2) Optimistic flip then toggle community status
      setIsCommunity(!previous);
      const response = await ToggleIsCommunityApiService.toggleIsCommunity(
        currentGenerationId,
        accessToken || undefined
      );
      if (typeof response.is_community === 'boolean') {
        setIsCommunity(response.is_community);
      } else if (typeof response.isCommunity === 'boolean') {
        setIsCommunity(response.isCommunity);
      }

      setShowCommunityNameModal(false);
      setCommunityNameInput("");
    } catch (error) {
      // Revert optimistic flip if it happened
      setIsCommunity(previous);
      console.error('Failed to post to community:', error);
      setCommunityNameError(
        error instanceof Error ? error.message : 'Failed to post to community'
      );
    } finally {
      setCommunityToggleLoading(false);
    }
  };
  
  // Function to refresh model data from localStorage
  const refreshModelData = () => {
    const { mpdContent: freshMpdContent, ldrContent: freshLdrContent, modelName: freshName } = getModelData();
    if (freshMpdContent) setMpdContent(freshMpdContent);
    if (freshLdrContent) setLdrContent(freshLdrContent);
    setModelName(freshName);
  };
  
  // Fetch price estimate when generation_id is available
  React.useEffect(() => {
    const fetchPriceEstimate = async () => {
      if (!currentGenerationId) {
        return;
      }
      
      setPriceLoading(true);
      setPriceError(null);
      
      try {
        const priceResponse = await GetPriceApiService.getPrice(
          currentGenerationId,
          accessToken || undefined
        );
        setPriceData(priceResponse);
      } catch (error) {
        console.error('GeneratedModel - Price fetch failed');
        setPriceError(error instanceof Error ? error.message : 'Failed to get price');
      } finally {
        setPriceLoading(false);
      }
    };

    fetchPriceEstimate();
  }, [currentGenerationId, priceRefreshCounter, accessToken]);

  // Handle resize model functionality
  const handleResizeModel = React.useCallback(async (detailLevel: number) => {
    if (!mpdContent) {
      console.error('No model content available for resizing');
      return;
    }

    // Use currentGenerationId state (set when loading from URL or localStorage)
    if (!currentGenerationId) {
      console.error('No generation ID found for resizing');
      return;
    }

    console.log('Resize detail_level:', detailLevel);

    setIsResizing(true);
    
    try {      
      const response = await ResizeModelApiService.resizeModel(
        currentGenerationId,
        detailLevel,
        accessToken || undefined
      );
      
      // Update generation ID and URL immediately
      if (response.generation_id) {
        localStorage.setItem('lastGenerationId', response.generation_id);
        localStorage.setItem('GENERATION_ID', response.generation_id);
        // If created while logged out, remember it so it can be claimed on login.
        if (!currentUser) recordAnonymousGeneration(response.generation_id);
        setCurrentGenerationId(response.generation_id);
        
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('id', response.generation_id);
        window.history.replaceState({}, '', newUrl.toString());
      }
      
      // Update xyzrgb content immediately if returned
      if (response.xyzrgb_content) {
        setXyzrgbContent(response.xyzrgb_content);
      }
      
      // Clear price data while polling
      setPriceData(null);
      
      // Resize API has returned — stop the resize loading indicator
      setIsResizing(false);
      
      // Cancel any previous polling (save or resize)
      if (savePollingAbortRef.current) {
        savePollingAbortRef.current.abort();
      }
      const abortController = new AbortController();
      savePollingAbortRef.current = abortController;
      
      setIsSavePolling(true);
      setSavePollingError(null);
      
      try {
        // Poll until generation completes (LDR processing finishes)
        const completedGeneration = await GetGenerationApiService.pollUntilComplete(
          response.generation_id,
          undefined,
          undefined,
          undefined,
          abortController.signal
        );
        
        console.log('[GeneratedModel] Resize polling completed:', completedGeneration.generation_id);
        
        // Update LDR content
        if (completedGeneration.ldr_content) {
          setLdrContent(completedGeneration.ldr_content);
          localStorage.setItem('LDR_CONTENT', completedGeneration.ldr_content);
          localStorage.setItem('lastLdrContent', completedGeneration.ldr_content);
        }
        
        // Get MPD content from URL or convert LDR to MPD
        let newMpdContent: string | null = null;
        if (completedGeneration.mpd_url) {
          try {
            const mpdResponse = await fetch(completedGeneration.mpd_url);
            if (mpdResponse.ok) {
              newMpdContent = await mpdResponse.text();
            }
          } catch (mpdError) {
            console.warn('Failed to fetch MPD from URL:', mpdError);
          }
        }
        
        if (!newMpdContent && completedGeneration.ldr_content) {
          try {
            const authToken = (await supabase.auth.getSession()).data.session?.access_token;
            const mpdData = await LdrToMpdApiService.convertLdrToMpd(
              completedGeneration.ldr_content,
              modelName,
              authToken
            );
            newMpdContent = mpdData.mpd_content;
          } catch (mpdError) {
            console.warn('Failed to convert LDR to MPD:', mpdError);
          }
        }
        
        if (newMpdContent) {
          setMpdContent(newMpdContent);
          localStorage.setItem('MPD_CONTENT', newMpdContent);
          localStorage.setItem('lastMpdContent', newMpdContent);
        }
        
        // Update xyzrgb URLs and content from completed generation
        if (completedGeneration.xyzrgb_url) {
          setXyzrgbUrl(completedGeneration.xyzrgb_url);
          
          try {
            const xyzrgbResponse = await fetch(completedGeneration.xyzrgb_url);
            if (xyzrgbResponse.ok) {
              const content = await xyzrgbResponse.text();
              setXyzrgbContent(content);
            }
          } catch (err) {
            console.warn('Failed to fetch xyzrgb content:', err);
          }
        }
        
        // Update problematic xyzrgb
        if (completedGeneration.problematic_xyzrgb_url) {
          setProblematicXyzrgbUrl(completedGeneration.problematic_xyzrgb_url);
          
          try {
            const problematicResponse = await fetch(completedGeneration.problematic_xyzrgb_url);
            if (problematicResponse.ok) {
              const problematicContent = await problematicResponse.text();
              setProblematicXyzrgbContent(problematicContent);
            }
          } catch (problematicErr) {
            console.warn('Failed to fetch problematic xyzrgb content:', problematicErr);
          }
        } else {
          setProblematicXyzrgbUrl(null);
          setProblematicXyzrgbContent(null);
        }
        
        // Clear screenshots and re-trigger price fetch
        setScreenshots(null);
        setPriceRefreshCounter(c => c + 1);

        // Keep the resize slider in sync with the newly generated model.
        setCurrentScaler(detailLevel);
        
        console.log(`Resize completed. New generation ID: ${response.generation_id}`);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          console.log('[GeneratedModel] Resize polling aborted (superseded)');
          return;
        }
        console.error('Resize polling failed:', error);
        setSavePollingError(error instanceof Error ? error.message : 'Failed to process model after resize');
      } finally {
        if (savePollingAbortRef.current === abortController) {
          setIsSavePolling(false);
          savePollingAbortRef.current = null;
        }
      }
    } catch (error) {
      console.error('GeneratedModel - Resize failed');
      setIsResizing(false);
    }
  }, [mpdContent, accessToken, currentGenerationId, modelName]);

  const handlePromptEditModel = React.useCallback(async () => {
    if (!editPrompt.trim()) {
      console.error('No prompt provided for editing');
      return;
    }

    // Use currentGenerationId state (set when loading from URL or localStorage)
    if (!currentGenerationId) {
      console.error('No generation ID found for prompt editing');
      return;
    }

    // Get modelOption based on quality selection
    const modelOption = editModelQuality === 'regular' ? 'a' : 'b';

    console.log('[GeneratedModel] Prompt edit:', editPrompt, 'modelOption:', modelOption);

    setIsPromptEditing(true);
    setEditPromptError(null);
    setEditPreviewImageUrl(null);
    
    try {      
      // Start the async edit operation
      const response = await PromptEditModelApiService.promptEditModel(
        currentGenerationId,
        editPrompt.trim(),
        accessToken || undefined,
        modelOption
      );
      
      const newGenerationId = response.generation_id;
      console.log('[GeneratedModel] Edit started, polling for status:', newGenerationId);
      
      // Poll for completion with status updates
      const completedGeneration = await GetGenerationApiService.pollUntilComplete(
        newGenerationId,
        (statusResponse: GetGenerationResponse) => {
          // Show preview image if available during processing
          if (statusResponse.external_image_url) {
            setEditPreviewImageUrl(statusResponse.external_image_url);
          }
        }
      );
      
      // Clear preview image after completion
      setEditPreviewImageUrl(null);
      
      console.log('[GeneratedModel] Edit completed:', completedGeneration.generation_id);
            
      // Update localStorage with new content
      localStorage.setItem('lastLdrContent', completedGeneration.ldr_content);
      setLdrContent(completedGeneration.ldr_content);
      
      localStorage.setItem('lastGenerationId', completedGeneration.generation_id);
      // If created while logged out, remember it so it can be claimed on login.
      if (!currentUser) recordAnonymousGeneration(completedGeneration.generation_id);
      setCurrentGenerationId(completedGeneration.generation_id);
      
      // Get MPD content from URL or convert LDR to MPD
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
      
      if (!mpdContent) {
        try {
          const authToken = (await supabase.auth.getSession()).data.session?.access_token;
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
      
      if (mpdContent) {
        localStorage.setItem('lastMpdContent', mpdContent);
        setMpdContent(mpdContent);
      }
      
      // Update xyzrgb URLs
      if (completedGeneration.xyzrgb_url) {
        setXyzrgbUrl(completedGeneration.xyzrgb_url);
      }
      if (completedGeneration.problematic_xyzrgb_url) {
        setProblematicXyzrgbUrl(completedGeneration.problematic_xyzrgb_url);
      }
      
      // Clear screenshots to force regeneration with new model
      setScreenshots(null);
      
      // Clear the prompt input after successful edit
      setEditPrompt('');
    } catch (error) {
      console.error('GeneratedModel - Prompt edit failed:', error);
      setEditPromptError(error instanceof Error ? error.message : 'Failed to edit model');
      setEditPreviewImageUrl(null);
    } finally {
      setIsPromptEditing(false);
    }
  }, [editPrompt, editModelQuality, accessToken, modelName, currentGenerationId]);

  // Guard an action (e.g. in-app navigation) behind the unsaved-changes modal.
  // If the voxel editor has unsaved changes, prompt the user; otherwise run immediately.
  const guardUnsavedChanges = (action: PendingExitAction) => {
    if (showVoxelEditor && voxelHasChanges) {
      pendingExitActionRef.current = action;
      setShowUnsavedChangesModal(true);
      return;
    }
    action();
  };

  const navigateToInstructions = () => {
    guardUnsavedChanges(() => navigate(`/instructions?id=${currentGenerationId}`));
  };

  const navigateToOrder = () => {
    guardUnsavedChanges(() => navigate("/order", {
      state: {
        name: modelName,
        parts_list: priceData?.parts_breakdown || [],
        screenshots,
        generation_id: currentGenerationId,
        priceData,
      },
    }));
  };

  const exitVoxelEditor = React.useCallback(() => {
    setShowVoxelEditor(false);
    setShowResizeScaler(false);
    setXyzrgbError(null);
  }, []);

  // Fetch the voxel data and switch into the Block Editor.
  const enterVoxelEditor = async () => {
    // Enter edit mode - fetch xyzrgb content
    if (!xyzrgbUrl) {
      setXyzrgbError('No voxel data available for this model');
      return;
    }

    setXyzrgbLoading(true);
    setXyzrgbError(null);

    try {
      // Fetch the xyzrgb content from the URL
      const response = await fetch(xyzrgbUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch voxel data: ${response.statusText}`);
      }
      
      const content = await response.text();
      setXyzrgbContent(content);
      
      // Fetch problematic xyzrgb content if URL is available
      if (problematicXyzrgbUrl) {
        try {
          const problematicResponse = await fetch(problematicXyzrgbUrl);
          if (problematicResponse.ok) {
            const problematicContent = await problematicResponse.text();
            setProblematicXyzrgbContent(problematicContent);
          }
        } catch (problematicErr) {
          // Non-fatal - just log and continue without problematic highlighting
          console.warn('Failed to fetch problematic xyzrgb content:', problematicErr);
        }
      }
      
      setShowVoxelEditor(true);
      setShowResizeScaler(true);
      posthog.capture('voxel_editor_opened', {
        generation_id: currentGenerationId,
        is_demo_model: isDemoModel,
      });
    } catch (err) {
      console.error('Failed to fetch xyzrgb content:', err);
      setXyzrgbError(`Failed to load voxel data: ${err}`);
    } finally {
      setXyzrgbLoading(false);
    }
  };

  const handleEditModelClick = async () => {
    posthog.capture('generated_model_edit_button_clicked', {
      generation_id: currentGenerationId,
      action: showVoxelEditor ? 'exit_editor' : 'enter_editor',
      is_demo_model: isDemoModel,
    });

    // If already in edit mode, check for unsaved changes before exiting
    if (showVoxelEditor) {
      if (voxelHasChanges) {
        pendingExitActionRef.current = () => {
          exitVoxelEditor();
        };
        setShowUnsavedChangesModal(true);
        return;
      }
      exitVoxelEditor();
      return;
    }

    await enterVoxelEditor();
  };

  const angles = [
    { label: "View angle 01", src: "" },
    { label: "View angle 02", src: "" },
    { label: "View angle 03", src: "" },
  ];

    const handleBackClick = React.useCallback(() => {
    navigate("/");
    }, [navigate]);

    const getSafeExportName = React.useCallback(() => {
      return (modelName || 'model')
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'model';
    }, [modelName]);

    const downloadBlob = React.useCallback((blob: Blob, fileName: string) => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }, []);

    const handleExportLdr = React.useCallback(() => {
      if (!ldrContent) return;
      setExportMenuOpen(false);
      const blob = new Blob([ldrContent], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, `${getSafeExportName()}.ldr`);
    }, [ldrContent, downloadBlob, getSafeExportName]);

    const handleExportPng = React.useCallback(() => {
      setExportMenuOpen(false);
      const pngDataUrl = previewPngDataUrl ?? exportCaptureApiRef.current?.capturePreviewPng() ?? null;
      if (!pngDataUrl) return;
      fetch(pngDataUrl)
        .then((res) => res.blob())
        .then((blob) => {
          downloadBlob(blob, `${getSafeExportName()}.png`);
        })
        .catch((err) => {
          console.warn('Failed to export PNG:', err);
        });
    }, [downloadBlob, getSafeExportName, previewPngDataUrl]);

    const handleExportVideo = React.useCallback(async () => {
      if (!exportCaptureApiRef.current || isExportingVideo) return;
      setExportMenuOpen(false);
      setIsExportingVideo(true);
      try {
        const result = await exportCaptureApiRef.current.capturePreviewVideo();
        if (!result) return;
        downloadBlob(result.blob, `${getSafeExportName()}.${result.extension}`);
      } catch (err) {
        console.warn('Failed to export video:', err);
      } finally {
        setIsExportingVideo(false);
      }
    }, [downloadBlob, getSafeExportName, isExportingVideo]);


  // Summer sale: 50% off everything (parts + shipping). The price returned by
  // the API already includes shipping, so we simply halve the total.
  const saleDiscountedPrice = priceData ? priceData.total_price * 0.5 : 0;

  return (
    <div className="min-h-screen text-slate-900" style={{ backgroundColor: "#ffffff" }}>
      <SEO
        title={`Generated Model — ${modelName}`}
        description="View your generated model, pricing, steps, and pieces."
        url="https://brickbuilder.ai/generated-model"
      />

      <LoginModal
        open={showLoginModal}
        onClose={() => {
          setShowLoginModal(false);
          setPendingCommunityPost(false);
          setPendingLikeAfterLogin(false);
        }}
        onSuccess={() => { void handleCommunityLoginSuccess(); }}
      />

      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-3">
        <Header onGuardedNavigate={(path) => guardUnsavedChanges(() => navigate(path))} />
        
        {/* Generate Another Button */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mt-4 mb-2 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Generate Another
        </button>

        {/* Loading state when fetching generation by ID */}
        {generationLoading && (
          <div className="flex flex-col items-center justify-center py-32">
            {/* Preview image during loading */}
            {editPreviewImageUrl && (
              <div className="relative w-full max-w-md mb-6">
                <img
                  src={editPreviewImageUrl}
                  alt="Generation preview"
                  className="w-full rounded-xl shadow-lg border border-slate-200"
                />
                <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full">
                  Processing...
                </div>
              </div>
            )}
            <Loader2 className="h-12 w-12 animate-spin text-[#f44336] mb-4" />
            <p className="text-slate-600">Loading model...</p>
          </div>
        )}

        {/* Error state when generation fetch fails */}
        {generationError && !generationLoading && (
          <div className="flex flex-col items-center justify-center py-32">
            <div className="text-red-500 text-lg font-semibold mb-4">Failed to Load Model</div>
            <p className="text-slate-600 mb-6">
              {/not found|404/i.test(generationError) ? 'Generation not found' : generationError}
            </p>

            {/* When running locally, the generation may only exist on the live
                hosted site. Offer a link to view it there. */}
            {IS_LOCAL_API && searchParams.get('id') && (
              <div className="max-w-md text-center bg-amber-50 border border-amber-200 rounded-xl px-6 py-4">
                <p className="text-sm text-slate-700">
                  This generation might be hosted on the live BrickBuilder site.{' '}
                  <a
                    href={`${LIVE_SITE_URL}/generated-model?id=${searchParams.get('id')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#f44336] hover:text-[#ff6b6b] underline"
                  >
                    View it there
                  </a>
                </p>
              </div>
            )}
          </div>
        )}

        {/* Main content - only show when not loading and no error */}
        {!generationLoading && !generationError && (
          <>
        {/* Centered Title - hide when in edit mode */}
        {!showVoxelEditor && (
          <section className="relative mt-2 mb-2 md:mb-3 landing-fade-in landing-delay-2">
            {/* <h2 className="text-lg sm:text-xl lg:text-2xl font-semibold text-center break-words px-4">
              Successfully Generated Model 🎉
            </h2> */}
            {currentGenerationId && (
              <p className="text-xs text-slate-400 text-center mt-1">
                {/* id: {currentGenerationId} */}
              </p>
            )}
            {/* <p className="text-sm text-slate-500 text-center italic mt-3 px-4">
              Generations offer a starting point, but it's up to you to resize, recolor, and reshape your model to perfection!
            </p> */}
          </section>
        )}

{/* Voxel Editor - shown when edit mode is active */}
{showVoxelEditor && xyzrgbContent ? (
  <section className="mt-6 md:mt-8 lg:mt-10">
    <div className="space-y-4">
      {/* Voxel editor */}
      <figure className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        <div
          className="relative h-[700px] w-full overflow-hidden rounded-xl bg-slate-50 md:h-auto md:max-h-[50vh]"
          style={{ aspectRatio: '3 / 2' }}
        >
          <VoxelViewer 
            xyzrgbContent={xyzrgbContent}
            problematicXyzrgbContent={problematicXyzrgbContent || undefined}
            generationId={currentGenerationId || undefined}
            accessToken={accessToken || undefined}
            referenceImageUrl={isDemoModel ? undefined : (processedImageUrl || undefined)}
            isProcessingSave={isSavePolling}
            onHasChangesChange={setVoxelHasChanges}
            saveRef={voxelSaveRef}
            capturePreviewRef={voxelCapturePreviewRef}
            showResizeScaler={!isDemoModel && showResizeScaler && !!mpdContent}
            onResize={handleResizeModel}
            isResizing={isResizing}
            resizeScaler={currentScaler}
            onResizeScalerChange={setCurrentScaler}
            onSaveSuccess={async (response) => {
            await handleUpdatedModelStarted(response, {
              captureVoxelPreview: true,
              preserveEditorContent: true,
            });
          }}
          />
        </div>
      </figure>
    </div>
  </section>
) : (
  /* Angle gallery with extra vertical spacing - hidden when voxel editor is shown */
  <section className="mt-2 md:mt-3">
    <div className="grid grid-cols-1 gap-4">
      {/* View angle screenshots disabled
      {angles.slice(0, 2).map((a, idx) => {
        const screenshotSrc = screenshots ? (idx === 0 ? screenshots.angle1 : screenshots.angle2) : null;
        const showSpinner = isSavePolling || (mpdContent && !screenshots);
        
        return (
          <figure
            key={idx}
            className="hidden md:block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div
              className="relative w-full overflow-hidden rounded-xl bg-slate-50"
              style={{ paddingTop: "66%" }}
            >
              <div className="absolute inset-0">
                {showSpinner ? (
                  <div className="flex items-center justify-center h-full bg-slate-50">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-8 h-8 border-[3px] border-gray-300 border-t-black rounded-full animate-spin"></div>
                    </div>
                  </div>
                ) : (
                  <img
                    src={screenshotSrc || a.src}
                    alt={a.label}
                    className="absolute inset-0 h-full w-full object-contain"
                  />
                )}
              </div>
            </div>
            <figcaption className="mt-3 text-xs text-slate-500 text-center">
              {a.label}
            </figcaption>
          </figure>
        );
      })}
      */}

      {/* 3D viewer - always visible */}
      <figure className="rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        <div
          className="relative w-full overflow-hidden rounded-xl bg-slate-50"
          style={{ aspectRatio: '3 / 2', maxHeight: '50vh' }}
        >
          <div ref={exportMenuRef} className="absolute right-3 top-3 z-20">
            <button
              type="button"
              aria-label="Export model"
                disabled={isSavePolling || isExportingVideo || (!ldrContent && !previewPngDataUrl)}
              onClick={() => setExportMenuOpen((prev) => !prev)}
              className="inline-flex items-center gap-2 rounded-full border border-slate-700/40 bg-slate-900/85 px-2.5 py-2 sm:px-4 text-xs font-semibold tracking-wide text-white shadow-lg shadow-black/30 backdrop-blur-sm transition-all duration-150 hover:bg-slate-800 hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-45"
            >
                {isExportingVideo ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              <span className="hidden sm:inline">Export</span>
            </button>

            {exportMenuOpen && (
              <div className="absolute right-0 mt-2 w-44 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                <button
                  type="button"
                  onClick={handleExportLdr}
                  disabled={!ldrContent}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <FileText size={14} />
                  LDraw (.ldr)
                </button>
                <button
                  type="button"
                  onClick={handleExportPng}
                  disabled={!previewPngDataUrl && !exportCaptureApiRef.current}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Image size={14} />
                  Image (.png)
                </button>
                <button
                  type="button"
                  onClick={() => { void handleExportVideo(); }}
                  disabled={!exportCaptureApiRef.current || isExportingVideo}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isExportingVideo ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />}
                  Video (.mp4)
                </button>
              </div>
            )}
          </div>
          <div ref={editHistoryMenuRef} className="absolute bottom-3 right-3 z-30">
            {editHistoryOpen && (
              <div
                id="edit-history-menu"
                role="dialog"
                aria-label="Previous model edits"
                className="absolute bottom-full right-0 mb-2 flex w-[calc(100vw-3rem)] max-w-sm flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white/95 text-left shadow-2xl shadow-black/25 backdrop-blur-md sm:w-96"
                style={{
                  maxHeight: 'max(7rem, min(22rem, calc((100vw - 2rem) * 0.6667 - 4.5rem), calc(50vh - 4.5rem)))',
                }}
              >
                <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3.5 py-2.5 sm:px-4">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Previous edits</h3>
                    {!editHistoryLoading && !editHistoryError && (
                      <p className="text-[11px] text-slate-500">
                        {editHistory.length} {editHistory.length === 1 ? 'version' : 'versions'} · newest first
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditHistoryOpen(false)}
                    aria-label="Close previous edits"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
                  >
                    <X size={15} />
                  </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5 sm:p-3">
                  {editHistoryLoading ? (
                    <div className="flex items-center justify-center gap-2 py-6 text-xs text-slate-500">
                      <Loader2 size={16} className="animate-spin text-[#f44336]" />
                      Loading edits...
                    </div>
                  ) : editHistoryError ? (
                    <div className="rounded-xl bg-red-50 px-3 py-4 text-center text-xs text-red-700">
                      {editHistoryError}
                    </div>
                  ) : editHistory.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-500">
                      No previous edits yet.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {editHistory.map((edit, index) => {
                        const isCurrentGeneration = edit.id === currentGenerationId;
                        const isCompleted = edit.status === 'completed';

                        return (
                          <div
                            key={edit.id}
                            className={`rounded-xl border p-2.5 sm:p-3 ${
                              isCurrentGeneration
                                ? 'border-[#f44336]/60 bg-red-50'
                                : 'border-slate-200 bg-white'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2.5">
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                                    Version {editHistory.length - index}
                                  </span>
                                  {isCurrentGeneration && (
                                    <span className="rounded-full bg-[#f44336] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                                      Current
                                    </span>
                                  )}
                                </div>
                                <p className="truncate font-mono text-[10px] text-slate-600 sm:text-[11px]" title={edit.id}>
                                  {edit.id}
                                </p>
                                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-slate-500">
                                  <span className="inline-flex items-center gap-1">
                                    <Calendar size={11} />
                                    {new Date(edit.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                  </span>
                                  <span className="inline-flex items-center gap-1">
                                    <Clock size={11} />
                                    {new Date(edit.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                                  </span>
                                </div>
                              </div>

                              {isCompleted && !isCurrentGeneration ? (
                                <a
                                  href={getGeneratedModelPath(edit.id)}
                                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-[11px] font-medium text-slate-700 transition-colors hover:border-[#f44336]/60 hover:text-[#f44336]"
                                >
                                  <Eye size={13} />
                                  View
                                </a>
                              ) : isCompleted ? (
                                <button
                                  type="button"
                                  disabled
                                  className="inline-flex h-8 shrink-0 cursor-default items-center rounded-lg border border-transparent bg-transparent text-[11px] font-medium text-slate-400"
                                >
                                  Viewing
                                </button>
                              ) : (
                                <span className="shrink-0 rounded-full bg-amber-100 px-2 py-1 text-[9px] font-semibold uppercase text-amber-700">
                                  {edit.status}
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            <button
              type="button"
              aria-controls="edit-history-menu"
              aria-expanded={editHistoryOpen}
              disabled={!processedImageUrl || isSavePolling}
              onClick={() => { void handleToggleEditHistory(); }}
              title={!processedImageUrl ? 'No edit history is available for this model' : 'View previous edits'}
              className="inline-flex items-center gap-2 rounded-full border border-slate-700/40 bg-slate-900/85 px-3 py-2 text-xs font-semibold text-white shadow-lg shadow-black/30 backdrop-blur-sm transition-all duration-150 hover:scale-[1.03] hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100 sm:px-4"
            >
              <History size={14} />
              <span>Previous edits</span>
              <ChevronUp
                size={13}
                className={`transition-transform duration-200 ${editHistoryOpen ? 'rotate-180' : ''}`}
              />
            </button>
          </div>
          <div className="absolute inset-0">
            {isSavePolling ? (
              <div className="flex items-center justify-center h-full bg-slate-50">
                <div className="flex flex-col items-center gap-3">
                  <div className="w-8 h-8 border-[3px] border-gray-300 border-t-black rounded-full animate-spin"></div>
                  <span className="text-xs text-slate-500">Processing build...</span>
                </div>
              </div>
            ) : mpdContent ? (
              <ThreeLDRViewer
                key={`${currentGenerationId ?? 'model'}-${mpdContent.length}`}
                modelContent={mpdContent}
                modelName={modelName}
                onPreviewCaptured={handlePreviewCaptured}
                onModelLoaded={() => setSceneReady(true)}
                onExportCaptureReady={handleExportCaptureReady}
                animateModelBuild
                /* onScreenshotsReady={setScreenshots} — disabled */
              />
            ) : (
              <div className="w-full h-full bg-slate-50"></div>
            )}
          </div>
        </div>
        <figcaption className="mt-1 text-xs text-slate-500 text-center">
          {/* Click/touch and drag to rotate, scroll/pinch to zoom */}
        </figcaption>
      </figure>
    </div>
  </section>
)}

        {/* Sections below the 3D preview fade in once the scene is ready */}
        <div
          className={sceneReady ? "below-preview-sequence" : ""}
          style={sceneReady ? undefined : { opacity: 0 }}
        >
        {/* Resize Scaler - shown outside edit mode */}
        {!showVoxelEditor && showResizeScaler && mpdContent && (
          <section className="mt-12 max-w-md mx-auto space-y-6">
            <ResizeScaler
              onResize={handleResizeModel}
              disabled={!mpdContent}
              isResizing={isResizing}
              scaler={currentScaler}
              onScalerChange={setCurrentScaler}
            />
          </section>
        )}

        {/* Centered model actions */}
        <section className="relative z-40 mt-4 mb-4 flex flex-col items-center gap-3 px-4">
          {/* Tip nudging users toward the Block Editor (hidden in edit mode) */}
          {!showVoxelEditor && (
            <p className="text-sm text-slate-500 text-center mb-2 max-w-2xl">
              Not what you were expecting? Try editing your model!
            </p>
          )}
          <div className="flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row sm:gap-6">
            <ModelEditControls
              isManualEditorOpen={showVoxelEditor}
              manualLoading={xyzrgbLoading}
              onManualEdit={() => { void handleEditModelClick(); }}
            />
            {/* Instructions button — white with grey border, turns red on hover */}
            <button
              type="button"
              aria-label="View instructions"
              onClick={navigateToInstructions}
              disabled={!currentGenerationId || isSavePolling}
              className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-gray-300 bg-white px-7 font-semibold text-black transition-all duration-150 hover:scale-[1.03] hover:border-[#f44336] hover:text-[#f44336] hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:min-w-44"
            >
              {isSavePolling ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <BookOpen size={16} />
                  Building Instructions
                </>
              )}
            </button>
          </div>

          <div className="flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row sm:gap-6">
            {isCommunity && (
              <button
                type="button"
                aria-label={hasLikedCommunityModel ? 'Unlike community model' : 'Like community model'}
                disabled={!currentGenerationId || likeToggleLoading || isSavePolling}
                onClick={() => {
                  void handleToggleCommunityLike();
                }}
                className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 px-7 font-semibold transition-all duration-150 sm:w-auto sm:min-w-44 ${
                  !currentGenerationId || likeToggleLoading || isSavePolling
                    ? 'bg-white text-gray-400 border-gray-200 cursor-not-allowed'
                    : hasLikedCommunityModel
                      ? 'bg-rose-50 text-rose-600 border-rose-200 cursor-pointer hover:bg-rose-100 hover:scale-[1.03] hover:shadow-lg'
                      : 'bg-white text-black border-gray-300 cursor-pointer hover:border-[#f44336] hover:text-[#f44336] hover:scale-[1.03] hover:shadow-lg'
                }`}
              >
                {likeToggleLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    Updating...
                  </>
                ) : (
                  <>
                    <Heart size={16} className={hasLikedCommunityModel ? 'fill-current' : ''} />
                    {hasLikedCommunityModel ? 'Liked' : 'Like Community Model'} · {likeCount}
                  </>
                )}
              </button>
            )}

            {/* Post / Remove from Community button — owners can toggle; logged-out
                visitors see it too and are prompted to log in on click */}
            {canShowCommunityButton && (
              <button
                type="button"
                aria-label={isCommunity ? 'Remove from community' : 'Post to community'}
                disabled={!currentGenerationId || communityToggleLoading || isSavePolling}
                onClick={() => {
                  if (!currentUser) {
                    setPendingCommunityPost(true);
                    setShowLoginModal(true);
                    return;
                  }
                  guardUnsavedChanges(() => { void handleToggleCommunity(); });
                }}
                className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 px-7 font-semibold transition-all duration-150 sm:w-auto sm:min-w-44 ${
                  !currentGenerationId || communityToggleLoading || isSavePolling
                    ? 'bg-white text-gray-400 border-gray-200 cursor-not-allowed'
                    : 'bg-white text-black border-gray-300 cursor-pointer hover:border-[#f44336] hover:text-[#f44336] hover:scale-[1.03] hover:shadow-lg'
                }`}
              >
                {communityToggleLoading ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    {isCommunity ? 'Removing...' : 'Posting...'}
                  </>
                ) : (
                  <>
                    <Users size={16} />
                    {isCommunity ? 'Remove from Community' : 'Post to Community'}
                  </>
                )}
              </button>
            )}

            {/* Order is the primary final action. */}
            <button
              type="button"
              aria-label="Order my kit"
              disabled={priceLoading || isSavePolling}
              onClick={navigateToOrder}
              className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 px-7 font-semibold text-white shadow-lg shadow-[#f44336]/25 transition-all duration-150 sm:w-auto sm:min-w-44 ${
                priceLoading || isSavePolling
                  ? 'cursor-not-allowed border-red-300 bg-red-300 opacity-70'
                  : 'cursor-pointer border-[#f44336] bg-[#f44336] hover:scale-[1.03] hover:border-[#ff6b6b] hover:bg-[#ff6b6b]'
              }`}
            >
              {priceLoading || isSavePolling ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white"></div>
                  Order my Kit!
                </>
              ) : (
                <>
                  <ShoppingCart size={16} />
                  Order
                </>
              )}
            </button>
          </div>
          
          {/* Error message for voxel editor */}
          {xyzrgbError && (
            <p className="text-red-500 text-sm">{xyzrgbError}</p>
          )}
          {savePollingError && (
            <p className="text-red-500 text-sm">{savePollingError}</p>
          )}
          {communityToggleError && (
            <p className="text-red-500 text-sm">{communityToggleError}</p>
          )}
        </section>

        {/* Congrats line */}
        <section className="mt-12">
          {/* <p className="text-base text-center md:text-left">
            <span className="font-semibold">Congratulations:</span>{" "}
            <span className="text-slate-700">your model is generated.</span>
          </p> */}
        </section>

        {/* Resize panel — shown above the stats badges when "Try resizing!" is pressed */}
        {showPriceResize && priceData && !priceLoading && !isSavePolling && !isDemoModel && (
          <section className="mt-6 max-w-xs mx-auto">
            <ResizeScaler
              onResize={handleResizeModel}
              disabled={!mpdContent}
              isResizing={isResizing}
              scaler={currentScaler}
              onScalerChange={setCurrentScaler}
            />
          </section>
        )}

        {/* Stats grid with hover animation */}
        <section className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          <div className="flex flex-col">
            <StatCard
              icon={(priceLoading || isSavePolling) ? (
                <div className="w-5 h-5 border-2 border-gray-300 border-t-black rounded-full animate-spin"></div>
              ) : (
                <HandCoins className="h-5 w-5 text-black" />
              )}
              title={
                (priceLoading || isSavePolling)
                  ? "Estimating Price..." 
                  : priceError 
                    ? "Price Unavailable"
                    : priceData 
                      ? (
                        <span className="flex items-baseline gap-2">
                          <span className="text-slate-400 line-through">${priceData.total_price.toFixed(2)}</span>
                          <span>${saleDiscountedPrice.toFixed(2)} {priceData.currency}</span>
                        </span>
                      )
                      : ""
              }
              sub={
                (priceLoading || isSavePolling)
                  ? "Loading price estimate..."
                  : priceError
                    ? "Unable to calculate pricing"
                    : priceData
                      ? "Total cost + shipping"
                      : ""
              }
              actionLabel="Order this model"
              disabled={priceLoading || isSavePolling || !priceData}
              onClick={() => {
                posthog.capture('generated_model_stat_action_clicked', {
                  action: 'order',
                  generation_id: currentGenerationId,
                  is_demo_model: isDemoModel,
                });
                navigateToOrder();
              }}
            />
            {/* Too expensive? Try resizing! */}
            {priceData && !priceLoading && !isSavePolling && !isDemoModel && (
              <div className="mt-2 text-center">
                <p className="text-sm text-slate-500">
                  Too expensive?{' '}
                  <button
                    type="button"
                    onClick={() => setShowPriceResize(prev => !prev)}
                    className="text-[#f44336] font-semibold hover:underline cursor-pointer bg-transparent border-none p-0 text-sm"
                  >
                    Try resizing!
                  </button>
                </p>
              </div>
            )}
          </div>
          <StatCard
            icon={(priceLoading || isSavePolling) ? (
              <div className="w-5 h-5 border-2 border-gray-300 border-t-black rounded-full animate-spin"></div>
            ) : (
              <Package className="h-5 w-5 text-black" />
            )}
            title={
              (priceLoading || isSavePolling)
                ? "Counting Pieces..."
                : priceData 
                  ? `${priceData.total_parts} Pieces`
                  : ""
            }
            sub={
              (priceLoading || isSavePolling)
                ? "Loading piece count..."
                : priceData 
                  ? ""
                  : ""
            }
            actionLabel="View building instructions"
            disabled={!currentGenerationId || isSavePolling || !priceData}
            onClick={() => {
              posthog.capture('generated_model_stat_action_clicked', {
                action: 'view_instructions',
                generation_id: currentGenerationId,
                is_demo_model: isDemoModel,
                source: 'pieces',
              });
              navigateToInstructions();
            }}
          />
          <StatCard
            icon={(priceLoading || isSavePolling) ? (
              <div className="w-5 h-5 border-2 border-gray-300 border-t-black rounded-full animate-spin"></div>
            ) : (
              <Boxes className="h-5 w-5 text-black" />
            )}
            title={
              (priceLoading || isSavePolling)
                ? "Calculating Weight..."
                : priceData
                  ? `${priceData.total_weight.toFixed(2)} kg`
                  : ""
            }
            sub={
              (priceLoading || isSavePolling)
                ? "Loading weight..."
                : priceData
                  ? "Total weight"
                  : ""
            }
            actionLabel="View building instructions"
            disabled={!currentGenerationId || isSavePolling || !priceData}
            onClick={() => {
              posthog.capture('generated_model_stat_action_clicked', {
                action: 'view_instructions',
                generation_id: currentGenerationId,
                is_demo_model: isDemoModel,
                source: 'weight',
              });
              navigateToInstructions();
            }}
          />
        </section>

        {/* Footer action bar */}
        <section className="mt-12 flex items-center justify-between">
          <div className="flex items-center gap-3">
          </div>
        </section>
        </div>
          </>
        )}

      {/* Unsaved changes confirmation modal */}
      {showUnsavedChangesModal && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: 3000 }}
          onClick={() => {
            pendingExitActionRef.current = null;
            setShowUnsavedChangesModal(false);
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl p-6 max-w-sm w-[90%] relative"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-800 mb-2">Save your changes?</h3>
            <p className="text-sm text-slate-500 mb-6">
              You have unsaved edits. Would you like to save before exiting edit mode?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  pendingExitActionRef.current = null;
                  setShowUnsavedChangesModal(false);
                }}
                className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setShowUnsavedChangesModal(false);
                  exitVoxelEditor();
                  setVoxelHasChanges(false);
                  const action = pendingExitActionRef.current;
                  pendingExitActionRef.current = null;
                  if (action) await action();
                }}
                className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer"
              >
                Discard
              </button>
              <button
                onClick={async () => {
                  setShowUnsavedChangesModal(false);
                  if (voxelSaveRef.current) {
                    await voxelSaveRef.current();
                  }
                  exitVoxelEditor();
                  setVoxelHasChanges(false);
                  const action = pendingExitActionRef.current;
                  pendingExitActionRef.current = null;
                  if (action) await action();
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-[#10B981] rounded-lg hover:bg-[#059669] transition-colors cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Community name modal — shown when posting to community */}
      {showCommunityNameModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={() => {
            if (communityToggleLoading) return;
            setShowCommunityNameModal(false);
            setCommunityNameError(null);
          }}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl p-6 max-w-md w-[90%] relative"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-slate-800 mb-2">Name your model</h3>
            <p className="text-sm text-slate-500 mb-4">
              Give your model a name before sharing it with the community.
            </p>
            <input
              type="text"
              autoFocus
              value={communityNameInput}
              onChange={(e) => {
                setCommunityNameInput(e.target.value);
                if (communityNameError) setCommunityNameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSubmitCommunityName();
                } else if (e.key === 'Escape' && !communityToggleLoading) {
                  setShowCommunityNameModal(false);
                  setCommunityNameError(null);
                }
              }}
              placeholder="Enter model name"
              maxLength={200}
              disabled={communityToggleLoading}
              className="w-full px-4 py-2.5 text-sm rounded-lg border-2 border-slate-200 focus:border-[#f44336] focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            />
            {communityNameError && (
              <p className="mt-2 text-sm text-red-500">{communityNameError}</p>
            )}

            {/* Username section — shows the username that will appear on the post */}
            <div className="mt-5 pt-4 border-t border-slate-100">
              {!isEditingUsername ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-slate-600">
                    Posting as{' '}
                    <span className="font-semibold text-slate-800">{displayUsername}</span>
                  </p>
                  <button
                    type="button"
                    onClick={handleStartEditUsername}
                    disabled={communityToggleLoading || !currentUserProfile}
                    className="text-sm font-medium text-[#f44336] hover:text-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Edit
                  </button>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Username
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      autoFocus
                      value={usernameInput}
                      onChange={(e) => {
                        setUsernameInput(e.target.value);
                        if (usernameError) setUsernameError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSaveUsername();
                        } else if (e.key === 'Escape' && !usernameSaving) {
                          handleCancelEditUsername();
                        }
                      }}
                      placeholder="Enter a username"
                      maxLength={30}
                      disabled={usernameSaving}
                      className="flex-1 px-3 py-2 text-sm rounded-lg border-2 border-slate-200 focus:border-[#f44336] focus:outline-none transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    />
                    <button
                      type="button"
                      onClick={handleSaveUsername}
                      disabled={usernameSaving || !usernameInput.trim()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {usernameSaving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={handleCancelEditUsername}
                      disabled={usernameSaving}
                      className="px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs text-slate-500">
                    3-30 characters. Letters, numbers, underscores, hyphens, or periods.
                  </p>
                  {usernameError && (
                    <p className="mt-2 text-sm text-red-500">{usernameError}</p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-3 justify-end mt-6">
              <button
                onClick={() => {
                  if (communityToggleLoading) return;
                  setShowCommunityNameModal(false);
                  setCommunityNameError(null);
                }}
                disabled={communityToggleLoading}
                className="px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitCommunityName}
                disabled={communityToggleLoading || !communityNameInput.trim() || isEditingUsername}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {communityToggleLoading ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Posting...
                  </>
                ) : (
                  'Post to Community'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      </div>

      <SiteFooter />
    </div>
  );
}
