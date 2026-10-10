import { NotificationMenu } from "../components/NotificationMenu";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import * as THREE from 'three';
import { LDrawParser, LDrawModel } from '../utils/ldrawParser';
import { ThreeLDRViewer } from '../components/ThreeLDRViewer';
import { MpdImageRenderer } from '../components/MpdImageRenderer';
import { supabase } from '../lib/supabase';
import { parseLDrawColors, getColorNameWithFallback, type LDrawColor } from '../utils/colorParser';
import { LdrToMpdApiService } from '../services/ldrToMpdApi';
import { NovaToBricksApiService } from '../services/novaToBricksApi';
import { GetGenerationApiService } from '../services/getGenerationApi';
import { useAuth } from '../contexts/AuthContext';
import { Loader2, Upload, Coins, X, Palette, ArrowLeft, LayoutDashboard } from 'lucide-react';
import jsPDF from 'jspdf';
import posthog from 'posthog-js';
import { SEO } from '../components/SEO';
import { SiteFooter } from '../components/SiteFooter';
import { ProfileMenu } from '../components/ProfileMenu';

function Header() {
  const navigate = useNavigate();
  const { user, userProfile, isSupabaseConfigured } = useAuth();

  // Show profile menu if user is logged in OR if Supabase is not configured
  const showProfileMenu = user || !isSupabaseConfigured;

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
        {showProfileMenu ? (
          // Logged in or no Supabase: show dashboard and account dropdown
          <>
            {/* Credits badge - only show when user is logged in with Supabase */}
            {user && isSupabaseConfigured && (
              <div className="flex items-center gap-1.5 bg-amber-50 border border-amber-200 rounded-full px-3 py-1.5">
                <Coins className="h-4 w-4 text-amber-600" />
                <span className="text-sm font-semibold text-amber-700">
                  {userProfile?.credits ?? 0}
                </span>
              </div>
            )}

            {/* Dashboard button */}
            <button
              className="inline-flex items-center gap-1.5 bg-transparent text-slate-700 border-none text-sm px-3 h-9 cursor-pointer transition-all duration-200 hover:text-[#f44336] hover:-translate-y-px"
              onClick={() => navigate('/dashboard')}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </button>

            {/* Account dropdown */}
            <ProfileMenu />
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
        {!showProfileMenu && <NotificationMenu />}
      </div>
      
    </header>
  );
}

// API Configuration for partToMpd (used in PDF generation)
const API_MODE = import.meta.env.VITE_API_MODE || 'local';
const LOCAL_API_URL = import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';
const RAILWAY_API_URL = import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app';
const RAILWAY_API_URL_STAGING = import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app';

// Determine API URLs based on mode
const getApiUrls = () => {
  if (API_MODE === 'local') {
    return {
      partToMpd: `${LOCAL_API_URL}/partToMpd`,
      baseUrl: LOCAL_API_URL
    };
  } else if (API_MODE === 'railway_staging') {
    return {
      partToMpd: `${RAILWAY_API_URL_STAGING}/partToMpd`,
      baseUrl: RAILWAY_API_URL_STAGING
    };
  } else {
    return {
      partToMpd: `${RAILWAY_API_URL}/partToMpd`,
      baseUrl: RAILWAY_API_URL
    };
  }
};

const API_URLS = getApiUrls();

// Part type mapping based on common LEGO brick files
const PART_TYPE_MAP: { [key: string]: string } = {
  '3005.dat': '1x1',
  '3004.dat': '1x2', 
  '3622.dat': '1x3',
  '3010.dat': '1x4',
  '3009.dat': '1x6',
  '3008.dat': '1x8',
  '6111.dat': '1x10',
  '3003.dat': '2x2',
  '3002.dat': '2x3',
  '3001.dat': '2x4',
  '2456.dat': '2x6',
  '3007.dat': '2x8',
  '3006.dat': '2x10',
};

// Function to extract part information from MPD content
const extractPartInfo = (mpdContent: string) => {
  const lines = mpdContent.split('\n');
  const parts: { filename: string; colorCode: number; count: number }[] = [];
  
  for (const line of lines) {
    if (line.startsWith('1 ')) {
      const parts_line = line.split(/\s+/);
      if (parts_line.length >= 15) {
        const colorCode = parseInt(parts_line[1]);
        const filename = parts_line[14];
        
        // Filter out sub-parts and primitives - only show main LEGO parts
        // Skip if it's a primitive (starts with specific patterns) or has "Main Colour"
        if (filename.startsWith('p/') || 
            filename.startsWith('parts/s/') || 
            filename.startsWith('s/') ||
            filename.includes('stud.dat') || 
            filename.includes('edge.dat') || 
            filename.includes('cyli.dat') || 
            filename.includes('disc.dat') || 
            filename.includes('box') ||
            colorCode === 16) {
          continue; // Skip sub-parts, primitives, and "Main Colour" parts
        }
        
        // Also skip if filename contains common primitive patterns but allow normal part files
        if ((filename.includes('/') && !filename.startsWith('parts/')) ||
            (filename.includes('4-4') && (filename.includes('edge') || filename.includes('cyli') || filename.includes('disc')))) {
          continue;
        }
        
        // Find existing part or add new one
        const existing = parts.find(p => p.filename === filename && p.colorCode === colorCode);
        if (existing) {
          existing.count++;
        } else {
          parts.push({ filename, colorCode, count: 1 });
        }
      }
    }
  }
  
  return parts;
};

// Parsed MPD structure for efficient step extraction
interface ParsedMpd {
  lines: string[];           // All lines of the MPD
  headerEndIndex: number;    // Index after header (where first part begins)
  stepEndIndices: number[];  // Index after each "0 STEP" line (inclusive)
  stepStartIndices: number[]; // Index where each step's parts begin
  subfileStartIndex: number; // Where subfiles begin
  headerJoined: string;      // Pre-joined header string
  subfileJoined: string;     // Pre-joined subfile string (huge, so join once)
}

// Parse MPD once to extract step boundaries
const parseMpdStructure = (mpdContent: string): ParsedMpd => {
  const lines = mpdContent.split('\n');
  let subfileStartIndex = lines.length;
  let headerEndIndex = 0;
  const headerLines: string[] = [];
  const stepEndIndices: number[] = [];
  const stepStartIndices: number[] = [];
  let headerComplete = false;
  let currentStepStart = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for subfile start
    if (line.startsWith('0 FILE') && i > 0) {
      subfileStartIndex = i;
      break;
    }
    
    // Collect header
    if (!headerComplete) {
      if (line.startsWith('0 ') && !line.startsWith('0 STEP')) {
        headerLines.push(lines[i]);
      } else if (line.startsWith('1 ')) {
        headerComplete = true;
        headerEndIndex = i;
        currentStepStart = i;
      }
    }
    
    // Track step boundaries
    if (headerComplete && line === '0 STEP') {
      stepStartIndices.push(currentStepStart);
      stepEndIndices.push(i + 1); // Include the STEP line
      currentStepStart = i + 1;
    }
  }
  
  return {
    lines,
    headerEndIndex,
    stepEndIndices,
    stepStartIndices,
    subfileStartIndex,
    headerJoined: headerLines.join('\n'),
    subfileJoined: lines.slice(subfileStartIndex).join('\n')
  };
};

// Get just one step's parts from MPD (for highlighting new parts) - fast
const getSingleStepMpd = (parsed: ParsedMpd, stepIndex: number): string => {
  if (stepIndex >= parsed.stepStartIndices.length) return '';
  
  const startIdx = parsed.stepStartIndices[stepIndex];
  const endIdx = parsed.stepEndIndices[stepIndex];
  const stepLines = parsed.lines.slice(startIdx, endIdx).filter(line => 
    line.trim().startsWith('1 ') || line.trim() === '0 STEP'
  );
  
  return parsed.headerJoined + '\n' + stepLines.join('\n') + '\n' + parsed.subfileJoined;
};

export function InstructionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  
  // Extract id param outside effects so we can use it as a stable dependency
  const generationId = searchParams.get('id');
  
  // Core state
  const [model, setModel] = useState<LDrawModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [stepInputValue, setStepInputValue] = useState('1'); // Separate state for input field
  const [parsedMpd, setParsedMpd] = useState<ParsedMpd | null>(null);
  
  // PDF generation state
  const [pdfGenerating, setPdfGenerating] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfProgressText, setPdfProgressText] = useState('');
  
  // LDR content for download
  const [ldrContent, setLdrContent] = useState<string | null>(null);
  
  // MPD content for download
  const [mpdContent, setMpdContent] = useState<string | null>(null);

  // File input ref for LDR upload
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // State to show/hide LDR buttons (for video recording)
  const [showLdrButtons, setShowLdrButtons] = useState(true);
  
  // State to toggle showing all colors vs highlighting new parts
  const [showAllColors, setShowAllColors] = useState(false);

  // Camera orientation state for preserving view across steps
  const [cameraState, setCameraState] = useState<{
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  } | null>(null);

  // Clear camera state when returning to first step for consistent starting point
  useEffect(() => {
    if (currentStepIndex === 0) {
      setCameraState(null);
    }
  }, [currentStepIndex]);

  // Sync step to URL when it changes (only after model is loaded)
  useEffect(() => {
    if (!model) return; // Don't sync before model loads - would overwrite URL param
    
    const currentStepParam = searchParams.get('step');
    const newStepParam = String(currentStepIndex + 1);
    if (currentStepParam !== newStepParam) {
      setSearchParams((prev) => {
        prev.set('step', newStepParam);
        return prev;
      }, { replace: true });
    }
  }, [currentStepIndex, model, searchParams, setSearchParams]);

  // Get LDR content from navigation state, URL params, or localStorage
  useEffect(() => {
    const parseModel = async () => {
      // Check for id parameter in URL
      
      if (generationId) {
        // Fetch generation data from API
        try {
          setLoading(true);
          setError(null);
          
          const generationData = await GetGenerationApiService.getGeneration(generationId);
          const { prompt, xyzrgb_url } = generationData;
          const ldr_content = generationData.endpoint === 'novaToBricks'
            ? await NovaToBricksApiService.instructions(generationId)
            : generationData.ldr_content;
          
          if (!ldr_content) {
            throw new Error('No LDR content found in generation data');
          }
          
          // Parse the LDR content
          const parsedModel = LDrawParser.parseLDRContent(ldr_content, prompt || 'Generated Model');
          
          setModel(parsedModel);
          setLdrContent(ldr_content);
          
          // Initialize step from URL param if valid, otherwise start at 0
          const stepParam = searchParams.get('step');
          const stepFromUrl = stepParam ? parseInt(stepParam) - 1 : 0;
          const initialStep = (stepFromUrl >= 0 && stepFromUrl < parsedModel.steps.length) ? stepFromUrl : 0;
          setCurrentStepIndex(initialStep);
          setStepInputValue(String(initialStep + 1));
          
          // Convert LDR to MPD
          try {
            const authToken = (await supabase.auth.getSession()).data.session?.access_token;
            const mpdData = await LdrToMpdApiService.convertLdrToMpd(
              ldr_content, 
              prompt || 'Generated Model', 
              authToken
            );
            if (mpdData.mpd_content) {
              setMpdContent(mpdData.mpd_content);
            }
          } catch (mpdError) {
            console.warn('Failed to convert LDR to MPD:');
          }
          
          setLoading(false);
          return;
          
        } catch (err) {
          console.error('Failed to fetch generation data:');
          setError(`Failed to load generation`);
          setLoading(false);
          return;
        }
      }
      
      // First, try to get LDR content from navigation state
      const stateData = location.state as { 
        ldrContent?: string,
        modelName?: string,
        mpdContent?: string
      } | null;

      let ldrContent = stateData?.ldrContent;
      let mpdContent = stateData?.mpdContent;
      let modelName = stateData?.modelName || 'model.ldr';
      
      // If not in state, try localStorage
      if (!ldrContent) {
        ldrContent = localStorage.getItem('lastLdrContent') || undefined;
        modelName = localStorage.getItem('lastModelName') || 'model.ldr';
      }
      
      if (!ldrContent) {
        setError('No LEGO model data found. Please go back and upload a model first.');
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const parsedModel = LDrawParser.parseLDRContent(ldrContent, modelName);
        
        setModel(parsedModel);
        setLdrContent(ldrContent);
        
        // Initialize step from URL param if valid, otherwise start at 0
        const stepParam = searchParams.get('step');
        const stepFromUrl = stepParam ? parseInt(stepParam) - 1 : 0;
        const initialStep = (stepFromUrl >= 0 && stepFromUrl < parsedModel.steps.length) ? stepFromUrl : 0;
        setCurrentStepIndex(initialStep);
        setStepInputValue(String(initialStep + 1));
        
        // Also load MPD content if available for BrickOwl wishlist
        // First try navigation state, then localStorage
        let mpdContentToSet = mpdContent;
        if (!mpdContentToSet) {
          mpdContentToSet = localStorage.getItem('lastMpdContent') || undefined;
        }
        if (mpdContentToSet) {
          setMpdContent(mpdContentToSet);
        }
        
        // Store in localStorage for future reference
        localStorage.setItem('lastLdrContent', ldrContent);
        localStorage.setItem('lastModelName', modelName);
        
      } catch (err) {
        console.error('Failed to parse LDR content:', err);
        setError(`Failed to parse LDR content: ${err}`);
      } finally {
        setLoading(false);
      }
    };

    parseModel();
  }, [generationId, location.state]);

  // Helper to export LDR for a single step
  function exportStepLdr(model: LDrawModel, stepIndex: number): string {
    // Generate LDR with all parts up to and including this step (cumulative)
    // The API will parse out the last step automatically
    const header = `0 FILE ${model.filename || 'step.ldr'}\n0 Name: ${model.filename || 'step.ldr'}\n0 Author: brickai\n0 !LDRAW_ORG Unofficial Model\n`;
    let lines: string[] = [header];
    
    for (let i = 0; i <= stepIndex; i++) {
      const step = model.steps[i];
      if (step && step.parts) {
        for (const part of step.parts) {
          // LDraw part line: 1 <color> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <filename>
          const { colorCode, x, y, z, matrix, filename } = part;
          // matrix is an array of 9 numbers: a-i
          lines.push(
            `1 ${colorCode} ${x} ${y} ${z} ${matrix.join(' ')} ${filename}`
          );
        }
      }
      lines.push('0 STEP');
    }
    
    const definitions = ldrContent ? LDrawParser.embeddedDefinitions(ldrContent) : '';
    return lines.join('\n') + (definitions ? '\n' + definitions : '');
  }

  // Parse MPD structure once when content loads (fast - just finds indices)
  useEffect(() => {
    if (!mpdContent) {
      setParsedMpd(null);
      return;
    }
    setParsedMpd(parseMpdStructure(mpdContent));
  }, [mpdContent]);

  // Compute single step MPD for parts panel (still needed for parts info display)
  const currentLastStepMpd = useMemo(() => {
    if (!parsedMpd) return null;
    return getSingleStepMpd(parsedMpd, currentStepIndex);
  }, [parsedMpd, currentStepIndex]);

  // Camera change handler for preserving orientation
  const handleCameraChange = (newCameraState: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  }) => {
    setCameraState(newCameraState);
  };
  
  // Keyboard navigation disabled
  // useEffect(() => {
  //   const handleKeyDown = (event: KeyboardEvent) => {
  //     if (!model || model.steps.length === 0) return;

  //     switch (event.key) {
  //       case 'ArrowLeft':
  //       case 'ArrowUp':
  //         event.preventDefault();
  //         setCurrentStepIndex(prev => Math.max(0, prev - 1));
  //         break;
  //       case 'ArrowRight':
  //       case 'ArrowDown':
  //         event.preventDefault();
  //         setCurrentStepIndex(prev => Math.min(model.steps.length - 1, prev + 1));
  //         break;
  //       case 'Home':
  //         event.preventDefault();
  //         setCurrentStepIndex(0);
  //         break;
  //       case 'End':
  //         event.preventDefault();
  //         setCurrentStepIndex(model.steps.length - 1);
  //         break;
  //       case 'Escape':
  //         event.preventDefault();
  //         navigate('/');
  //         break;
  //     }
  //   };

  //   window.addEventListener('keydown', handleKeyDown);
  //   return () => window.removeEventListener('keydown', handleKeyDown);
  // }, [model, navigate]);

  // Helper function to convert LDrawParts back to LDR format
  const convertPartsToLdr = (parts: LDrawModel['parts'], modelName: string = 'temp_model'): string => {
    const ldrLines = [
      `0 ${modelName}`,
      `0 Name: ${modelName}.ldr`,
      `0 Author: BrickAI`,
      '0',
    ];
    
    parts.forEach(part => {
      // Convert matrix back to LDraw format
      const matrix = part.matrix;
      const ldrLine = `1 ${part.colorCode} ${part.x} ${part.y} ${part.z} ${matrix.join(' ')} ${part.filename}`;
      ldrLines.push(ldrLine);
    });
    
    return ldrLines.join('\n');
  };

  // Helper function to render MPD content to PNG
  const renderMpdToPng = async (mpdContent: string, width = 400, height = 300): Promise<string> => {
    return new Promise(async (resolve, reject) => {
      try {
        // Dynamic imports for Three.js
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');
        const { LDrawLoader } = await import('three/examples/jsm/loaders/LDrawLoader.js');
        const { LDrawConditionalLineMaterial } = await import('three/examples/jsm/materials/LDrawConditionalLineMaterial.js');

        // Create scene, camera, renderer
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xdeebed);

        const camera = new THREE.PerspectiveCamera(45, width / height, 1, 10000);
        const renderer = new THREE.WebGLRenderer({ 
          antialias: true, 
          preserveDrawingBuffer: true
        });
        
        renderer.setSize(width, height);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;

        // Environment setup
        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        scene.environment = pmremGenerator.fromScene(new RoomEnvironment()).texture;

        // Controls for calculating good camera position
        const controls = new OrbitControls(camera, renderer.domElement);

        // Load the MPD model
        const loader = new LDrawLoader();
        loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
        loader.smoothNormals = false;

        // Create blob URL for the MPD content
        const blob = new Blob([mpdContent], { type: 'text/plain' });
        const objectUrl = URL.createObjectURL(blob);

        loader.load(
          objectUrl,
          (modelGroup: THREE.Group) => {
            // Rotate the model to match the original implementation
            modelGroup.rotation.x = Math.PI;
            scene.add(modelGroup);

            // Calculate bounding box and adjust camera
            const bbox = new THREE.Box3().setFromObject(modelGroup);
            const size = bbox.getSize(new THREE.Vector3());
            const radius = Math.max(size.x, Math.max(size.y, size.z)) * 0.5;

            // Set camera position based on model size
            const center = bbox.getCenter(new THREE.Vector3());
            controls.target.copy(center);
            camera.position.set(-2.3, 1, 2).multiplyScalar(radius).add(center);
            controls.update();

            // Render the scene
            renderer.render(scene, camera);

            // Convert to image URL
            const canvas = renderer.domElement;
            const dataUrl = canvas.toDataURL('image/png');

            // Cleanup
            URL.revokeObjectURL(objectUrl);
            renderer.dispose();
            pmremGenerator.dispose();

            resolve(dataUrl);
          },
          undefined,
          (error) => {
            console.error('Failed to load MPD for image rendering:', error);
            URL.revokeObjectURL(objectUrl);
            renderer.dispose();
            reject(error);
          }
        );
      } catch (err) {
        console.error('Error rendering MPD to image:', err);
        reject(err);
      }
    });
  };

  // PDF Generation function
  const generatePDF = async () => {
    if (!model) return;

    const pdf = new jsPDF();
    
    try {
      setPdfGenerating(true);
      setPdfProgress(0);
      setPdfProgressText('Starting PDF generation...');

      // Calculate total steps for progress tracking
      const maxInstructionSteps = model.steps.length; // Generate all steps, not just first 5
      const sortedPartsCount = Array.from(new Set(model.parts.map(part => `${part.colorCode}:${part.filename}`))).length;
      const totalSteps = 2 + sortedPartsCount + maxInstructionSteps; // title page + parts list + instruction steps
      let currentStep = 0;

      const updateProgress = (step: number, text: string) => {
        setPdfProgress(Math.round((step / totalSteps) * 100));
        setPdfProgressText(text);
      };

      // Initialize color map for the PDF
      let colorMap: Map<number, LDrawColor> | undefined = undefined;

      // Add title page
      pdf.setFontSize(20);
      pdf.text('LEGO Building Instructions', 20, 30);
      pdf.setFontSize(12);
      const titleModelName = model.filename ? model.filename.replace(/\.[^/.]+$/, '') : 'Untitled';
      pdf.text(`Model: ${titleModelName}`, 20, 50);
      pdf.text(`Total Steps: ${model.steps.length}`, 20, 60);
      pdf.text(`Total Parts: ${model.parts.length}`, 20, 70);
      
      currentStep++;
      updateProgress(currentStep, 'Creating parts list...');

      // Add parts list
      pdf.setFontSize(16);
      pdf.text('Parts List', 20, 110);
      
      // Count parts by color and type
      const partsCount = new Map<string, number>();
      model.parts.forEach(part => {
        const partKey = `${part.colorCode}:${part.filename}`;
        partsCount.set(partKey, (partsCount.get(partKey) || 0) + 1);
      });
      
      // Sort parts for better organization
      const sortedParts = Array.from(partsCount.entries()).sort(([a], [b]) => {
        const [colorA, nameA] = a.split(':');
        const [colorB, nameB] = b.split(':');
        // Sort by color first, then by part name
        if (colorA !== colorB) return parseInt(colorA) - parseInt(colorB);
        return nameA.localeCompare(nameB);
      });
      
      pdf.setFontSize(10);
      let yPos = 130;
      
      // Process each part with individual images from partToMpd API
      for (let partIndex = 0; partIndex < sortedParts.length; partIndex++) {
        const [partKey, quantity] = sortedParts[partIndex];
        const [colorCode, filename] = partKey.split(':');
        const partName = filename.replace('.dat', '').replace(/[_-]/g, ' ');
        
        currentStep++;
        updateProgress(currentStep, `Adding part ${partIndex + 1} of ${sortedParts.length} to parts list...`);
        
        const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
        
        if (yPos > 250) { // Start new page if needed (leaving space for part image)
          pdf.addPage();
          pdf.setFontSize(16);
          pdf.text('Parts List (continued)', 20, 30);
          pdf.setFontSize(10);
          yPos = 50;
        }
        
        try {
          // Get individual part MPD from API
          const partNumber = filename.replace('.dat', '').replace('.DAT', '');
          
          const partResponse = await fetch(API_URLS.partToMpd, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
            },
            body: JSON.stringify({
              part_number: partNumber,
              color: parseInt(colorCode)
            }),
          });
          
          if (partResponse.ok) {
            const partData = await partResponse.json();
            const partMpdContent = partData.mpd_content;
            
            if (partMpdContent && partMpdContent !== "0") {
              // Parse colors from the first MPD response if we haven't already
              if (!colorMap) {
                colorMap = parseLDrawColors(partMpdContent);
              }
              
              const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
              
              // Render part image
              const partImage = await renderMpdToPng(partMpdContent, 150, 100);
              
              // Add part image and text with color name
              pdf.addImage(partImage, 'PNG', 20, yPos, 20, 13); // Small part image for parts list
              pdf.text(`${quantity}x ${colorName}: ${partName}`, 50, yPos + 7);
            } else {
              // Fallback if part content is "0" or invalid
              const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
              pdf.text(`${quantity}x ${colorName}: ${partName}`, 30, yPos + 7);
            }
          } else {
            // Fallback if part API fails
            pdf.text(`${quantity}x ${colorName}: ${partName}`, 30, yPos + 7);
          }
        } catch (partError) {
          console.warn(`Failed to get part image for parts list ${filename}:`, partError);
          // Fallback text only
          pdf.text(`${quantity}x ${colorName}: ${partName}`, 30, yPos + 7);
        }
        
        yPos += 20; // Space for next part (increased for image)
      }
      
      // Add each step (all steps now included)
      const maxSteps = model.steps.length; // Generate all steps, not just first 5
      for (let i = 0; i < maxSteps; i++) {
        const step = model.steps[i];
        
        currentStep++;
        updateProgress(currentStep, `Creating instruction step ${i + 1} of ${maxSteps}...`);
        
        pdf.addPage();
        
        // Step header
        pdf.setFontSize(18);
        pdf.text(`Step ${step.stepNumber}`, 20, 30);
        
        try {
          // Use the same API approach as the main viewer to get MPD content
          // Generate LDR content for this step and get MPD from API
          const stepLdrContent = convertPartsToLdr(step.parts, `step_${step.stepNumber}`);
          const cumulativeLdrContent = convertPartsToLdr(step.cumulativeParts, `model_step_${step.stepNumber}`);
          
          // Get auth token
          const authToken = (await supabase.auth.getSession()).data.session?.access_token;
          
          const [stepData, cumulativeData] = await Promise.all([
            LdrToMpdApiService.convertLdrToMpd(stepLdrContent, `step_${step.stepNumber}`, authToken),
            LdrToMpdApiService.convertLdrToMpd(cumulativeLdrContent, `model_step_${step.stepNumber}`, authToken)
          ]);
          
          const stepMpdContent = stepData.mpd_content;
          const cumulativeMpdContent = cumulativeData.mpd_content;
          
          // Parse colors from the first MPD response if we haven't already
          if (!colorMap) {
            colorMap = parseLDrawColors(cumulativeMpdContent);
          }
          
          // Render both images
          const [stepImage, cumulativeImage] = await Promise.all([
            renderMpdToPng(stepMpdContent, 300, 200),
            renderMpdToPng(cumulativeMpdContent, 300, 200)
          ]);
          
          // Add cumulative model image (how it looks after this step) - 25% smaller than before
          try {
            pdf.addImage(cumulativeImage, 'PNG', 20, 50, 80, 53); // 300x200 scaled to 80x53 (maintains 3:2 ratio)
          } catch (imgError) {
            console.error(`Failed to add cumulative image to PDF:`, imgError);
            pdf.text('(Cumulative image failed to render)', 20, 90);
          }
          
          // Add step parts image (parts to add in this step) with part names and quantities
          try {
            pdf.addImage(stepImage, 'PNG', 20, 160, 32, 21); // 300x200 scaled to 32x21 (2.5x smaller than 80x53)
          } catch (imgError) {
            console.error(`Failed to add step image to PDF:`, imgError);
            pdf.text('(Step image failed to render)', 20, 170);
          }
          
          // Show part names with quantities next to the step parts image
          let yPos = 170; // Split the difference: (160 + 180) / 2 = 170
          pdf.setFontSize(10);
          
          // Count parts in this step for quantities
          const stepPartsCount = new Map<string, number>();
          step.parts.forEach(part => {
            if (part.colorCode <= 1000) { // Skip invalid color codes
              const partKey = `${part.colorCode}:${part.filename}`;
              stepPartsCount.set(partKey, (stepPartsCount.get(partKey) || 0) + 1);
            }
          });
          
          // Display unique parts with quantities
          const uniqueParts = Array.from(stepPartsCount.entries());
          uniqueParts.forEach(([partKey, quantity]) => {
            const [colorCode, filename] = partKey.split(':');
            const partName = filename.replace('.dat', '').replace(/[_-]/g, ' ');
            const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
            
            if (yPos > 270) { // Start new page if needed
              pdf.addPage();
              pdf.setFontSize(10);
              yPos = 40; // Split the difference for new pages too: (30 + 50) / 2 = 40
            }
            
            pdf.text(`x ${quantity} ${colorName}: ${partName}`, 60, yPos);
            yPos += 12;
          });
          
        } catch (imageError) {
          console.warn('Failed to generate images for step', step.stepNumber, imageError);
          
          // Fallback to text-only if image generation fails
          let yPos = 70;
          step.parts.forEach((part, partIndex) => {
            if (yPos > 270) {
              pdf.addPage();
              pdf.setFontSize(12);
              yPos = 30;
            }
            const partName = part.filename.replace('.dat', '').replace(/[_-]/g, ' ');
            pdf.text(`• Color ${part.colorCode}: ${partName}`, 30, yPos);
            yPos += 10;
          });
        }
      }
      
      // Download the PDF
      updateProgress(totalSteps, 'Finalizing PDF...');
      const modelName = model.filename ? model.filename.replace(/\.[^/.]+$/, '') : 'model';
      pdf.save(`${modelName}-build-instructions.pdf`);
      
    } catch (error) {
      console.error('Error generating PDF:', error);
      alert('Failed to generate PDF. Please try again.');
    } finally {
      setPdfGenerating(false);
      setPdfProgress(0);
      setPdfProgressText('');
    }
  };

  // Parts List PDF Generation function
  const generatePartsListPDF = async () => {
    if (!model) return;

    const pdf = new jsPDF();
    
    try {
      setPdfGenerating(true);
      setPdfProgress(0);
      setPdfProgressText('Starting parts list generation...');

      // Calculate total steps for progress tracking
      const sortedPartsCount = Array.from(new Set(model.parts.map(part => `${part.colorCode}:${part.filename}`))).length;
      const totalSteps = 1 + sortedPartsCount; // title page + parts
      let currentStep = 0;

      const updateProgress = (step: number, text: string) => {
        setPdfProgress(Math.round((step / totalSteps) * 100));
        setPdfProgressText(text);
      };

      // Initialize color map for the PDF
      let colorMap: Map<number, LDrawColor> | undefined = undefined;

      // Add title page
      pdf.setFontSize(20);
      pdf.text('Parts List', 20, 30);
      pdf.setFontSize(12);
      const titleModelName = model.filename ? model.filename.replace(/\.[^/.]+$/, '') : 'Untitled';
      pdf.text(`Model: ${titleModelName}`, 20, 50);
      pdf.text(`Total Parts: ${model.parts.length}`, 20, 60);
      
      currentStep++;
      updateProgress(currentStep, 'Creating parts list...');

      // Add parts list
      pdf.setFontSize(16);
      pdf.text('Parts List', 20, 90);
      
      // Count parts by color and type
      const partsCount = new Map<string, number>();
      model.parts.forEach(part => {
        const partKey = `${part.colorCode}:${part.filename}`;
        partsCount.set(partKey, (partsCount.get(partKey) || 0) + 1);
      });
      
      // Sort parts for better organization
      const sortedParts = Array.from(partsCount.entries()).sort(([a], [b]) => {
        const [colorA, nameA] = a.split(':');
        const [colorB, nameB] = b.split(':');
        if (colorA !== colorB) return parseInt(colorA) - parseInt(colorB);
        return nameA.localeCompare(nameB);
      });
      
      pdf.setFontSize(10);
      let yPos = 110;
      
      // Process each part with individual images from partToMpd API
      for (let partIndex = 0; partIndex < sortedParts.length; partIndex++) {
        const [partKey, quantity] = sortedParts[partIndex];
        const [colorCode, filename] = partKey.split(':');
        const partName = filename.replace('.dat', '').replace(/[_-]/g, ' ');
        
        currentStep++;
        updateProgress(currentStep, `Adding part ${partIndex + 1} of ${sortedParts.length}...`);
        
        if (yPos > 250) { // Start new page if needed
          pdf.addPage();
          pdf.setFontSize(16);
          pdf.text('Parts List (continued)', 20, 30);
          pdf.setFontSize(10);
          yPos = 50;
        }
        
        try {
          // Get individual part MPD from API
          const partNumber = filename.replace('.dat', '').replace('.DAT', '');
          
          const partResponse = await fetch(API_URLS.partToMpd, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${(await supabase.auth.getSession()).data.session?.access_token}`,
            },
            body: JSON.stringify({
              part_number: partNumber,
              color: parseInt(colorCode)
            })
          });
          
          if (partResponse.ok) {
            const partData = await partResponse.json();
            const partMpdContent = partData.mpd_content;
            
            if (partMpdContent && partMpdContent !== "0") {
              if (!colorMap) {
                colorMap = parseLDrawColors(partMpdContent);
              }
              
              const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
              
              // Generate image for this individual part
              const partImage = await renderMpdToPng(partMpdContent, 300, 200);
              
              // Add part image and text with color name
              pdf.addImage(partImage, 'PNG', 20, yPos, 20, 13);
              pdf.text(`${quantity}x ${colorName}: ${partName}`, 50, yPos + 7);
            } else {
              // Fallback if part content is "0" or invalid
              const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
              pdf.text(`${quantity}x ${colorName}: ${partName}`, 30, yPos + 7);
            }
          } else {
            // Fallback if part API fails
            const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
            pdf.text(`${quantity}x ${colorName}: ${partName}`, 30, yPos + 7);
          }
        } catch (partError) {
          console.error(`Failed to get part image for ${filename}:`, partError);
          const colorName = getColorNameWithFallback(parseInt(colorCode), colorMap);
          pdf.text(`${quantity}x ${colorName}: ${partName}`, 30, yPos + 7);
        }
        
        yPos += 25;
      }
      
      // Save the PDF
      updateProgress(totalSteps, 'Finalizing parts list PDF...');
      const modelName = model.filename ? model.filename.replace(/\.[^/.]+$/, '') : 'model';
      pdf.save(`${modelName}_parts_list.pdf`);
      
    } catch (error) {
      console.error('Error generating parts list PDF:', error);
      alert('Failed to generate parts list PDF. Please try again.');
    } finally {
      setPdfGenerating(false);
      setPdfProgress(0);
      setPdfProgressText('');
    }
  };

  // LDR Download function
  const downloadLDR = () => {
    if (!ldrContent || !model) return;
    
    const filename = model.filename ? model.filename.replace(/\.[^/.]+$/, '') + '.ldr' : 'model.ldr';
    const blob = new Blob([ldrContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // MPD Download function
  const downloadMPD = () => {
    if (!mpdContent || !model) return;
    
    const filename = model.filename ? model.filename.replace(/\.[^/.]+$/, '') + '.mpd' : 'model.mpd';
    const blob = new Blob([mpdContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // LDR Upload handler
  const handleLdrUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setLoading(true);
      setError(null);

      const content = await file.text();
      const modelName = file.name;

      // Parse the LDR content
      const parsedModel = LDrawParser.parseLDRContent(content, modelName);

      // Update all relevant state
      setModel(parsedModel);
      setLdrContent(content);
      setCurrentStepIndex(0);
      setStepInputValue('1');
      setMpdContent(null);
      setCameraState(null);

      // Store in localStorage
      localStorage.setItem('lastLdrContent', content);
      localStorage.setItem('lastModelName', modelName);

      // Convert LDR to MPD
      try {
        const authToken = (await supabase.auth.getSession()).data.session?.access_token;
        const mpdData = await LdrToMpdApiService.convertLdrToMpd(
          content,
          modelName,
          authToken
        );
        if (mpdData.mpd_content) {
          setMpdContent(mpdData.mpd_content);
        }
      } catch (mpdError) {
        console.warn('Failed to convert LDR to MPD:', mpdError);
      }

      posthog.capture('instructions_ldr_uploaded', {
        model_name: modelName,
        total_steps: parsedModel.steps.length,
        total_parts: parsedModel.parts.length
      });

    } catch (err) {
      console.error('Failed to parse uploaded LDR file:', err);
      setError(`Failed to parse LDR file: ${err}`);
    } finally {
      setLoading(false);
      // Reset file input so the same file can be uploaded again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen text-slate-900" style={{ backgroundColor: "#ffffff" }}>
        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-6">
          <Header />
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <Loader2 className="h-12 w-12 animate-spin text-[#f44336] mx-auto mb-4" />
              <p className="text-slate-600">Loading building instructions...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen text-slate-900" style={{ backgroundColor: "#ffffff" }}>
        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-6">
          <Header />
          <div className="flex-1 flex items-center justify-center">
            <div className="max-w-md mx-auto text-center p-6">
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4">
                <p className="text-red-800 font-medium">Error</p>
                <p className="text-red-600 text-sm mt-1">{error}</p>
              </div>
              <button
                onClick={() => navigate(-1)}
                className="px-6 py-2 bg-[#f44336] text-white rounded-full hover:bg-[#ff6b6b] transition-all"
              >
                Go Back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }


  if (!model || model.steps.length === 0) {
    return (
      <div className="min-h-screen text-slate-900" style={{ backgroundColor: "#ffffff" }}>
        <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-6">
          <Header />
          <div className="flex-1 flex items-center justify-center">
            <div className="max-w-md mx-auto text-center p-6">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
                <p className="text-amber-800 font-medium">No Instructions Available</p>
                <p className="text-amber-700 text-sm mt-1">No building steps found in the model</p>
              </div>
              <button
                onClick={() => navigate(-1)}
                className="px-6 py-2 bg-[#f44336] text-white rounded-full hover:bg-[#ff6b6b] transition-all"
              >
                Go Back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <SEO title="Building Instructions — BrickBuilder" description="Step-by-step building instructions for your brick model." url="https://brickbuilder.ai/instructions" />
    <div className="min-h-screen text-slate-900" style={{ backgroundColor: "#ffffff" }}>
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 sm:px-6 md:px-8 lg:px-10 pb-16 pt-6">
        <Header />
        
        {/* Back to Model Button */}
        {generationId && (
          <button
            onClick={() => navigate(`/generated-model?id=${generationId}`)}
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mt-4 mb-2 transition-colors landing-fade-in landing-delay-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Model
          </button>
        )}
      
      {pdfGenerating ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center max-w-md w-full px-6">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#f44336] mx-auto mb-6"></div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">Generating PDF...</h2>
            <p className="text-slate-600 mb-6">{pdfProgressText}</p>
            
            {/* Progress Bar */}
            <div className="w-full bg-slate-200 rounded-full h-3 mb-2">
              <div 
                className="bg-[#f44336] h-3 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${pdfProgress}%` }}
              ></div>
            </div>
          </div>
        </div>
      ) : (
      <div className="flex-1 mt-6">
        {/* Page Title */}
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-2">
          Building Instructions
        </h1>
        <p className="text-sm text-slate-500 mb-6">
          {generationId && `id: ${generationId} • `}
          {model.steps.length} steps • {model.parts.length} parts
        </p>
              
        {/* Download and Action Buttons */}
        <div className="flex flex-wrap gap-2 sm:gap-3 mb-8">
          {/* Download PDF button hidden
          <button
            onClick={() => {
              posthog.capture('instructions_download_full_pdf_clicked', {
                model_name: model?.filename || 'unknown',
                total_steps: model?.steps.length || 0,
                total_parts: model?.parts.length || 0
              });
              generatePDF();
            }}
            disabled={pdfGenerating}
            className="px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed text-white hover:bg-[#ff6b6b] disabled:bg-slate-300 disabled:text-slate-500"
            style={{ 
              backgroundColor: pdfGenerating ? undefined : '#f44336'
            }}
          >
            {pdfGenerating ? 'Generating PDF...' : 'Download PDF'}
          </button>
          */}
          {/* Download Parts List button hidden
          <button
            onClick={() => {
              posthog.capture('instructions_download_parts_list_clicked', {
                model_name: model?.filename || 'unknown',
                total_steps: model?.steps.length || 0,
                total_parts: model?.parts.length || 0
              });
              generatePartsListPDF();
            }}
            disabled={pdfGenerating}
            className="px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed text-white hover:bg-[#ff6b6b] disabled:bg-slate-300 disabled:text-slate-500"
            style={{ 
              backgroundColor: pdfGenerating ? undefined : '#f44336'
            }}
          >
            {pdfGenerating ? 'Generating PDF...' : 'Download Parts List'}
          </button>
          */}
          {/* LDR buttons hidden
          {showLdrButtons && (
            <>
              <button
                onClick={() => {
                  posthog.capture('instructions_download_ldr_clicked', {
                    model_name: model?.filename || 'unknown',
                    total_steps: model?.steps.length || 0,
                    total_parts: model?.parts.length || 0
                  });
                  downloadLDR();
                }}
                disabled={!ldrContent}
                className="px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed text-white hover:bg-[#ff6b6b] disabled:bg-slate-300 disabled:text-slate-500"
                style={{ 
                  backgroundColor: !ldrContent ? undefined : '#f44336'
                }}
              >
                Export .LDR
              </button>
              <input
                type="file"
                ref={fileInputRef}
                accept=".ldr"
                onChange={handleLdrUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-full text-sm font-medium transition-all duration-200 border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 flex items-center gap-2"
              >
                Upload .LDR
              </button>
              <button
                onClick={() => setShowLdrButtons(false)}
                className="p-2 rounded-full text-sm font-medium transition-all duration-200 border border-slate-300 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                title="Hide LDR buttons"
              >
                <X size={16} />
              </button>
            </>
          )}
          */}
        </div>

        {/* Instructions Content */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-6">
            <div className="space-y-1">

            {/* Current Step Display */}
            {model.steps[currentStepIndex] && (
              <div className="border border-slate-200 rounded-xl p-6">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-lg font-semibold text-[#f44336]">
                Step {model.steps[currentStepIndex].stepNumber}
                </h4>
                <div className="text-sm text-slate-600">
                Add {model.steps[currentStepIndex].parts.length} part
                </div>
              </div>
              
              <div className="mb-4 relative">
                {mpdContent ? (
                  <>
                    <ThreeLDRViewer 
                    modelContent={mpdContent}
                    modelName={``}
                    autoRotate={false}
                    initialCameraState={cameraState || undefined}
                    onCameraChange={handleCameraChange}
                    preserveOrientation={true}
                    highlightNewParts={!showAllColors}
                    newPartsContent={currentLastStepMpd || undefined}
                    currentStepIndex={currentStepIndex}
                    totalSteps={model.steps.length}
                    showBaseplate={true}
                    softenEdges={false}
                    />
                    <div className="absolute top-3 right-3 flex flex-col items-center gap-1">
                      <button
                        onClick={() => setShowAllColors(!showAllColors)}
                        className={`p-2 rounded-lg transition-all duration-200 shadow-md ${
                          showAllColors 
                            ? 'bg-[#f44336] text-white' 
                            : 'bg-white text-slate-600 hover:bg-slate-100'
                        }`}
                        title={showAllColors ? 'Show new parts highlighted' : 'Show all colors'}
                      >
                        <Palette size={20} />
                      </button>
                      <span className="text-[8px] sm:text-[12px] text-slate-500 font-medium select-none">
                        {showAllColors ? 'Hide Colors' : 'Show Colors'}
                      </span>
                    </div>
                  </>
                ) : (
                <div className="text-center text-slate-500">Loading model...</div>
                )}
              </div>

              {/* Step Navigation */}
              <div className="bg-slate-50 p-3 sm:p-4 rounded-xl mb-4">
                <div className="flex items-center justify-center space-x-2 sm:space-x-4">
                <button
                  onClick={() => {
                    const newIndex = Math.max(0, currentStepIndex - 1);
                    setCurrentStepIndex(newIndex);
                    setStepInputValue(String(newIndex + 1));
                  }}
                  disabled={currentStepIndex === 0 || !model}
                  className="py-2 px-3 sm:px-6 rounded-full text-xs sm:text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed touch-manipulation"
                  style={{
                    backgroundColor: (currentStepIndex === 0 || !model) ? '#e2e8f0' : '#1e293b',
                    color: (currentStepIndex === 0 || !model) ? '#94a3b8' : '#FFFFFF',
                  }}
                  title="Go to previous step"
                >
                  Previous
                </button>
                
                <div className="flex items-center space-x-1 sm:space-x-2">
                  <span className="text-slate-600 text-xs sm:text-base">Step</span>
                  <input
                    type="number"
                    min="0"
                    max={model.steps.length}
                    value={stepInputValue}
                    onChange={(e) => {
                      const value = e.target.value;
                      setStepInputValue(value); // Always update the input display
                      
                      // Only update the actual step if it's a valid number
                      const stepNumber = parseInt(value);
                      if (!isNaN(stepNumber) && stepNumber >= 1 && stepNumber <= model.steps.length) {
                        setCurrentStepIndex(stepNumber - 1);
                      }
                    }}
                    onBlur={() => {
                      // Reset to current step if invalid on blur
                      setStepInputValue(String(currentStepIndex + 1));
                    }}
                    className="w-12 sm:w-16 px-1 sm:px-2 py-1 text-center text-xs sm:text-base border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#f44336] focus:border-transparent"
                  />
                  <span className="text-slate-600 text-xs sm:text-base">of {model.steps.length}</span>
                </div>
                
                <button
                  onClick={() => {
                    const newIndex = Math.min(model.steps.length - 1, currentStepIndex + 1);
                    setCurrentStepIndex(newIndex);
                    setStepInputValue(String(newIndex + 1));
                  }}
                  disabled={currentStepIndex === model.steps.length - 1}
                  className="py-2 px-3 sm:px-6 rounded-full text-xs sm:text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed touch-manipulation"
                  style={{
                    backgroundColor: currentStepIndex === model.steps.length - 1 ? '#e2e8f0' : '#1e293b',
                    color: currentStepIndex === model.steps.length - 1 ? '#94a3b8' : '#FFFFFF',
                  }}
                  title="Next step (→ or ↓ arrow keys)"
                >
                  Next
                </button>
                </div>
              </div>

              {/* Parts added in this step - Shows only new parts */}
              {currentLastStepMpd && (
                <div className="bg-slate-50 p-4 rounded-xl">
                  <h5 className="font-medium mb-3 text-slate-900">Parts added in this step:</h5>
                  <div className="flex gap-4">
                    <div className="shrink-0 w-[88px] h-[56px] sm:w-44 sm:h-28 rounded-xl border border-slate-200 overflow-hidden" style={{ backgroundColor: '#deebed' }}>
                      <MpdImageRenderer 
                        mpdContent={currentLastStepMpd}
                        width={176}
                        height={112}
                        className=""
                      />
                    </div>
                    <div className="pt-2">
                    {(() => {
                      const stepParts = LDrawParser.getPartsListForStep(model.steps[currentStepIndex]).map(part => ({ ...part, count: part.quantity }));
                      return (
                        <div className="space-y-2">
                          {stepParts.map((part, index) => {
                            // Extract just the part number from filename (e.g., "parts/3005" -> "3005.dat")
                            const partNumber = part.filename.replace('parts/', '').replace(/\.dat/i, '');
                            const partWithDat = `${partNumber}.dat`;
                            const partType = PART_TYPE_MAP[partWithDat] || partWithDat;
                            const colorName = getColorNameWithFallback(part.colorCode, parseLDrawColors(currentLastStepMpd));
                            return (
                              <div key={index} className="text-sm text-slate-600">
                                <div>
                                  Type: {partType}
                                </div>
                                <div>
                                  Color: {colorName}
                                </div>
                                <div>
                                  Quantity: {part.count}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                  </div>
                </div>
                )}
              </div>
            )}
            </div>
        </div>
      </div>
      )}
      </div>
    </div>

    <SiteFooter />
    </>
  );
}