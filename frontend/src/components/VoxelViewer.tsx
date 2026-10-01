import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { captureTransparentPreview } from '../utils/captureTransparentPreview';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Link } from 'react-router-dom';
import { MousePointer2, Move, Save, Pipette, Brush, Plus, Trash2, Undo2, Redo2, BoxSelect, ChevronDown, Box, Minus, ChevronLeft, ChevronRight, HelpCircle, X, AlertTriangle } from 'lucide-react';
import { UpdateModelApiService, UpdateModelResponse } from '../services/updateModelApi';
import posthog from 'posthog-js';
import { useDirtyAutosave } from '../hooks/useDirtyAutosave';

type InteractionMode = 'select' | 'pan' | 'add' | 'paint';
type SelectSubMode = 'regular' | 'byColor' | 'marquee';

interface Voxel {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
}

interface PaletteColor {
  name: string;
  hex: string;
  r: number;
  g: number;
  b: number;
}

interface VoxelViewerProps {
  xyzrgbContent: string;
  problematicXyzrgbContent?: string;
  className?: string;
  generationId?: string;
  accessToken?: string;
  referenceImageUrl?: string;
  isProcessingSave?: boolean;
  onVoxelSelect?: (voxels: Voxel[] | null, indices: number[] | null) => void;
  onVoxelsChange?: (newContent: string) => void;
  onSaveSuccess?: (response: UpdateModelResponse) => void | Promise<void>;
  onHasChangesChange?: (hasChanges: boolean) => void;
  saveRef?: React.MutableRefObject<(() => Promise<void>) | null>;
  // Exposes a function that renders the current voxel scene to a clean PNG
  // data URL, so the parent can capture a preview without leaving the editor.
  capturePreviewRef?: React.MutableRefObject<(() => string | null) | null>;
  // Resize scaler props
  showResizeScaler?: boolean;
  onResize?: (detailLevel: number) => Promise<void>;
  isResizing?: boolean;
  resizeScaler?: number;
  onResizeScalerChange?: (value: number) => void;
}

// History action types for undo/redo
type HistoryAction = 
  | { type: 'colorChange'; voxelIndices: number[]; oldColors: { r: number; g: number; b: number }[]; newColors: { r: number; g: number; b: number }[] }
  | { type: 'addVoxel'; voxel: Voxel; index: number }
  | { type: 'deleteVoxels'; voxels: Voxel[]; indices: number[] };

// Parse xyzrgb content: each line is "x y z r g b"
function parseXyzrgb(content: string): Voxel[] {
  const voxels: Voxel[] = [];
  const lines = content.trim().split('\n');
  
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 6) {
      const [x, y, z, r, g, b] = parts.map(Number);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z) && !isNaN(r) && !isNaN(g) && !isNaN(b)) {
        voxels.push({ x, y, z, r, g, b });
      }
    }
  }
  
  return voxels;
}

// LEGO 1x1 brick dimensions (relative to 1 unit width)
const LEGO_HEIGHT = 1.2;  // Height ratio (9.6mm / 8mm)
const STUD_DIAMETER = 0.6; // Stud diameter ratio (4.8mm / 8mm)
const STUD_HEIGHT = 0.22;  // Stud height ratio (1.8mm / 8mm)
const STUD_SEGMENTS = 16;  // Number of segments for the cylinder
const LDRAW_PLASTIC_MATERIAL: THREE.MeshStandardMaterialParameters = {
  roughness: 0.3,
  metalness: 0,
};

const disposeInstancedMesh = (mesh: THREE.InstancedMesh) => {
  mesh.geometry.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) {
    material.forEach((mat) => mat.dispose());
  } else {
    material.dispose();
  }
  mesh.dispose();
};

const setVoxelColorFromRgb = (color: THREE.Color, r: number, g: number, b: number) => {
  color.setRGB(r / 255, g / 255, b / 255);
  return color.convertSRGBToLinear();
};

const buildVoxelDisplayRoom = (
  scene: THREE.Scene,
  bbox: THREE.Box3,
  center: THREE.Vector3,
  maxDim: number,
) => {
  const existing = scene.getObjectByName('display-room');
  if (existing) scene.remove(existing);

  const room = new THREE.Group();
  room.name = 'display-room';

  const floorMat = new THREE.MeshStandardMaterial({ color: 0xc8b99a, roughness: 0.85, metalness: 0.0 });
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf0ebe1, roughness: 0.95, metalness: 0.0 });
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x8b5e3c, roughness: 0.7, metalness: 0.05 });
  const legMat = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.75, metalness: 0.05 });

  const roomW = maxDim * 6;
  const roomH = maxDim * 4;
  const roomD = maxDim * 6;
  const tableThick = maxDim * 0.05;
  const tableTopSurface = bbox.min.y;
  const tableTopY = tableTopSurface - tableThick / 2;
  const floorY = tableTopY - tableThick / 2 - maxDim * 0.6;

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomD), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, floorY, center.z);
  floor.receiveShadow = true;
  room.add(floor);

  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(roomW, roomH), wallMat);
  backWall.position.set(center.x, floorY + roomH / 2, center.z - roomD / 2);
  backWall.receiveShadow = true;
  room.add(backWall);

  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(roomD, roomH), wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(center.x - roomW / 2, floorY + roomH / 2, center.z);
  leftWall.receiveShadow = true;
  room.add(leftWall);

  const tableGroup = new THREE.Group();
  tableGroup.name = 'display-table';
  // Used by the animation loop to hide the table once the camera drops below
  // the table's top surface, keeping the model's underside visible.
  tableGroup.userData.hideBelowY = tableTopSurface;

  const tabletop = new THREE.Mesh(new THREE.BoxGeometry(roomW, tableThick, roomD), tableMat);
  tabletop.position.set(center.x, tableTopY, center.z);
  tabletop.castShadow = true;
  tabletop.receiveShadow = true;
  tableGroup.add(tabletop);

  const legH = tableTopY - tableThick / 2 - floorY;
  const legR = maxDim * 0.025;
  const legGeo = new THREE.CylinderGeometry(legR, legR, legH, 8);
  const legPositions = [
    [center.x - roomW / 2 + legR * 3, floorY + legH / 2, center.z - roomD / 2 + legR * 3],
    [center.x + roomW / 2 - legR * 3, floorY + legH / 2, center.z - roomD / 2 + legR * 3],
    [center.x - roomW / 2 + legR * 3, floorY + legH / 2, center.z + roomD / 2 - legR * 3],
    [center.x + roomW / 2 - legR * 3, floorY + legH / 2, center.z + roomD / 2 - legR * 3],
  ];

  for (const [x, y, z] of legPositions) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, y, z);
    leg.castShadow = true;
    tableGroup.add(leg);
  }

  room.add(tableGroup);
  scene.add(room);
};

// Create a LEGO brick geometry with a stud on top
// The brick height is along Z axis, stud points +Z (so after group rotation it points up)
function createLegoBrickGeometry(size: number = 1): THREE.BufferGeometry {
  const height = size * LEGO_HEIGHT;
  const halfHeight = height / 2;
  
  // Create the brick body (box) - height along Z axis
  const brickGeometry = new THREE.BoxGeometry(size, size, height);
  
  // Create the stud (cylinder) - rotated to point along Z axis
  const studRadius = (size * STUD_DIAMETER) / 2;
  const studHeight = size * STUD_HEIGHT;
  const studGeometry = new THREE.CylinderGeometry(studRadius, studRadius, studHeight, STUD_SEGMENTS);
  
  // Rotate cylinder to point along Z axis (from Y to Z)
  studGeometry.rotateX(Math.PI / 2);
  
  // Position the stud on top of the brick (+Z face)
  studGeometry.translate(0, 0, halfHeight + studHeight / 2);
  
  // Merge the geometries
  const mergedGeometry = mergeBufferGeometries([brickGeometry, studGeometry]);
  
  return mergedGeometry || brickGeometry;
}

// Helper function to determine edge color based on voxel color brightness
function getEdgeColor(r: number, g: number, b: number): number {
  // Calculate relative luminance using standard formula
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  
  // If color is light (luminance > 0.5), use dark edges, otherwise use light edges
  return luminance > 0.5 ? 0x333333 : 0xCCCCCC;
}

// Simple geometry merge function
function mergeBufferGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geometries.length === 0) return null;
  if (geometries.length === 1) return geometries[0];
  
  let totalVertices = 0;
  let totalIndices = 0;
  
  for (const geo of geometries) {
    const pos = geo.getAttribute('position');
    totalVertices += pos.count;
    const index = geo.getIndex();
    if (index) {
      totalIndices += index.count;
    } else {
      totalIndices += pos.count;
    }
  }
  
  const positions = new Float32Array(totalVertices * 3);
  const normals = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);
  
  let vertexOffset = 0;
  let indexOffset = 0;
  let vertexCount = 0;
  
  for (const geo of geometries) {
    const pos = geo.getAttribute('position');
    const norm = geo.getAttribute('normal');
    const idx = geo.getIndex();
    
    // Copy positions
    for (let i = 0; i < pos.count; i++) {
      positions[(vertexOffset + i) * 3] = pos.getX(i);
      positions[(vertexOffset + i) * 3 + 1] = pos.getY(i);
      positions[(vertexOffset + i) * 3 + 2] = pos.getZ(i);
    }
    
    // Copy normals
    if (norm) {
      for (let i = 0; i < norm.count; i++) {
        normals[(vertexOffset + i) * 3] = norm.getX(i);
        normals[(vertexOffset + i) * 3 + 1] = norm.getY(i);
        normals[(vertexOffset + i) * 3 + 2] = norm.getZ(i);
      }
    }
    
    // Copy indices (offset by current vertex count)
    if (idx) {
      const idxArray = idx.array;
      for (let i = 0; i < idx.count; i++) {
        indices[indexOffset + i] = idxArray[i] + vertexCount;
      }
      indexOffset += idx.count;
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices[indexOffset + i] = vertexCount + i;
      }
      indexOffset += pos.count;
    }
    
    vertexCount += pos.count;
    vertexOffset += pos.count;
  }
  
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  
  return merged;
}

export function VoxelViewer({ xyzrgbContent, problematicXyzrgbContent, className = '', generationId, accessToken, referenceImageUrl, isProcessingSave, onVoxelSelect, onVoxelsChange, onSaveSuccess, onHasChangesChange, saveRef, capturePreviewRef, showResizeScaler, onResize, isResizing, resizeScaler, onResizeScalerChange }: VoxelViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animationFrameRef = useRef<number>(0);
  const instancedMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const edgesLineRef = useRef<THREE.LineSegments | null>(null);
  const edgeVertCountRef = useRef<number>(0);
  const selectedIndicesRef = useRef<Set<number>>(new Set());
  const voxelsRef = useRef<Voxel[]>([]);
  const voxelGroupRef = useRef<THREE.Group | null>(null);
  const highlightMeshesRef = useRef<THREE.Mesh[]>([]);
  const problematicHighlightsRef = useRef<THREE.Mesh[]>([]);

  // Save state
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const changeVersionRef = useRef(0);

  const markChanged = () => {
    changeVersionRef.current += 1;
    setHasChanges(true);
  };

  const trackMenuClick = (menuItem: string, properties: Record<string, unknown> = {}) => {
    posthog.capture('voxel_editor_menu_item_clicked', {
      generation_id: generationId,
      menu_item: menuItem,
      ...properties,
    });
  };

  // Notify parent when hasChanges changes
  useEffect(() => {
    onHasChangesChange?.(hasChanges);
  }, [hasChanges, onHasChangesChange]);

  // Warn the user before refreshing/closing the tab if there are unsaved changes.
  // Use a ref so we can attach the listener once and always read the latest value,
  // which avoids edge cases where rapid re-renders detach the listener.
  const hasChangesRef = useRef(hasChanges);
  useEffect(() => {
    hasChangesRef.current = hasChanges;
  }, [hasChanges]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasChangesRef.current) return;
      e.preventDefault();
      // Required for legacy browsers; modern browsers show their own generic message.
      e.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // Expose save + preview-capture functions to parent via refs
  useEffect(() => {
    if (saveRef) {
      saveRef.current = handleSave;
    }
    if (capturePreviewRef) {
      capturePreviewRef.current = capturePreview;
    }
    return () => {
      if (saveRef) {
        saveRef.current = null;
      }
      if (capturePreviewRef) {
        capturePreviewRef.current = null;
      }
    };
  });

  // Undo/Redo history state
  const [historyStack, setHistoryStack] = useState<HistoryAction[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyStackRef = useRef<HistoryAction[]>([]);
  const historyIndexRef = useRef(-1);

  // Keep refs in sync with state for use in event handlers
  useEffect(() => {
    historyStackRef.current = historyStack;
    historyIndexRef.current = historyIndex;
  }, [historyStack, historyIndex]);

  // Color palette state
  const [colorPalette, setColorPalette] = useState<PaletteColor[]>();
  const [selectedColor, setSelectedColor] = useState<PaletteColor | null>(null);

  // Interaction mode state
  const [mode, setMode] = useState<InteractionMode>('select');
  const modeRef = useRef<InteractionMode>('select');
  
  // Select sub-mode state
  const [selectSubMode, setSelectSubMode] = useState<SelectSubMode>('regular');
  const selectSubModeRef = useRef<SelectSubMode>('regular');
  
  // Add mode color state
  const [addColor, setAddColor] = useState<PaletteColor | null>(null);
  const addColorRef = useRef<PaletteColor | null>(null);
  
  // Paint mode color state
  const [paintColor, setPaintColor] = useState<PaletteColor | null>(null);
  const paintColorRef = useRef<PaletteColor | null>(null);
  
  // Paint stroke tracking for batching into single undo action
  const paintStrokeRef = useRef<Map<number, { oldColor: { r: number; g: number; b: number }; newColor: { r: number; g: number; b: number } }>>(new Map());
  
  // Keep addColorRef in sync with addColor state
  useEffect(() => {
    addColorRef.current = addColor;
  }, [addColor]);
  
  // Keep paintColorRef in sync with paintColor state
  useEffect(() => {
    paintColorRef.current = paintColor;
  }, [paintColor]);

  // Marquee selection state - use refs for values needed in event handlers
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<{ x: number; y: number } | null>(null);
  const selectionStartRef = useRef<{ x: number; y: number } | null>(null);
  
  // Track selection count for UI updates
  const [selectionCount, setSelectionCount] = useState(0);

  // Select dropdown state
  const [selectDropdownOpen, setSelectDropdownOpen] = useState(false);

  // Reference image visibility state
  const [referenceImageVisible, setReferenceImageVisible] = useState(true);

  // Problematic voxels modal state
  const [showProblematicModal, setShowProblematicModal] = useState(false);

  // Resize warning modal state
  const [showResizeWarning, setShowResizeWarning] = useState(false);

  // Color palette expansion state
  const [paletteExpanded, setPaletteExpanded] = useState(false);
  const [resizeExpanded, setResizeExpanded] = useState(true);

  // Sphere rotator state
  const sphereCanvasRef = useRef<HTMLCanvasElement>(null);
  const [isDraggingSphere, setIsDraggingSphere] = useState(false);
  const sphereDragStartRef = useRef<{ x: number; y: number } | null>(null);
  const sphereDragCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const initialRotationRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const [sphereMode, setSphereMode] = useState<'rotate' | 'pan' | 'zoom'>('rotate');
  const sphereModeRef = useRef<'rotate' | 'pan' | 'zoom'>('rotate');
  const initialCameraPositionRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const initialZoomRef = useRef<number | null>(null);

  // Tutorial state
  const [showTutorial, setShowTutorial] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const showTutorialRef = useRef(false);
  const tutorialStepRef = useRef(0);

  // Keep tutorial refs in sync
  useEffect(() => {
    showTutorialRef.current = showTutorial;
    tutorialStepRef.current = tutorialStep;
  }, [showTutorial, tutorialStep]);

  // Show tutorial on first visit
  useEffect(() => {
    // const hasSeenTutorial = localStorage.getItem('brickai-edit-tutorial-seen');
    // if (!hasSeenTutorial) {
      setShowTutorial(true);
      setTutorialStep(0);
    // }
  }, []);

  const closeTutorial = () => {
    setShowTutorial(false);
    setTutorialStep(0);
    // localStorage.setItem('brickai-edit-tutorial-seen', 'true');
  };

  const tutorialSteps = [
    {
      action: 'start',
      title: 'Welcome to the Block Editor! 🧱',
      instruction: 'This interactive tutorial will guide you through each editing tool. Press "Start" below to begin!'
    },
    {
      action: 'rotateView',
      title: 'Step 1: Rotate',
      instruction: 'Click and drag the sphere (bottom center) to rotate the model. You can also right-click and drag with a mouse anywhere on the canvas.'
    },
    {
      action: 'panMode',
      title: 'Step 2: Pan',
      instruction: 'Use the arrows next to the sphere to switch to Pan mode. Then click and drag the sphere to pan the view.'
    },
    {
      action: 'zoomMode',
      title: 'Step 3: Zoom',
      instruction: 'Switch to Zoom mode using the arrows. Then drag the sphere up/down to zoom in and out. You can also scroll with your mouse wheel.'
    },
    {
      action: 'regularSelect',
      title: 'Step 4: Regular Select',
      instruction: 'Click on a block to select it. You can also click and drag to select multiple blocks.'
    },
    {
      action: 'switchToByColor',
      title: 'Step 5: Selection Mode',
      instruction: 'Click the select button to open the dropdown, then choose "By Color" to switch selection modes.'
    },
    {
      action: 'byColorSelect',
      title: 'Step 6: Select By Color',
      instruction: 'Click on any block to select all blocks that share the same color.'
    },
    {
      action: 'marqueeSelect',
      title: 'Step 7: Marquee Select',
      instruction: 'Change to "Marquee" select mode. \n\n Then click and drag to draw a rectangle around blocks. All blocks fully inside will be selected.'
    },
    {
      action: 'changeColor',
      title: 'Step 8: Change Color',
      instruction: 'With blocks selected, pick a different color from the palette (bottom right) to recolor them.'
    },
    {
      action: 'delete',
      title: 'Step 9: Delete Blocks',
      instruction: 'Select some blocks, then click the red delete button in the toolbar to remove them.'
    },
    {
      action: 'paint',
      title: 'Step 10: Paint',
      instruction: 'Click the paintbrush icon to enter paint mode. \n Click on a block to paint it with the selected color. Drag across blocks for a brush effect.'
    },
    {
      action: 'add',
      title: 'Step 11: Add Block',
      instruction: 'Click on any face of an existing block to place a new block next to it.'
    },
    {
      action: 'undo',
      title: 'Step 12: Undo',
      instruction: 'Press the Undo button (bottom left) or ⌘Z / Ctrl+Z to undo your last action.'
    },
    {
      action: 'save',
      title: 'Step 13: Save',
      instruction: 'Press the Save button (bottom left) to persist your changes. You can view previous saves in the dashboard.'
    },
    {
      action: 'resize',
      title: 'Step 14: Resize',
      instruction: 'Adjust the resize slider (bottom right) and click "Resize" to change the detail level.'
    },
    {
      action: 'done',
      title: 'Tutorial Complete! 🎉',
      instruction: 'You now know all the editing tools. Happy building!'
    }
  ];

  // Ref-based advance function so useEffect handlers can call it
  const advanceTutorialRef = useRef<(action: string) => void>(() => {});
  
  useEffect(() => {
    advanceTutorialRef.current = (action: string) => {
      if (!showTutorialRef.current) return;
      const currentStep = tutorialStepRef.current;
      if (currentStep >= tutorialSteps.length) return;
      
      const step = tutorialSteps[currentStep];
      if (step.action !== action) return;
      
      const nextStep = currentStep + 1;
      setTutorialStep(nextStep);
      
      // Auto-set modes for upcoming steps
      if (nextStep < tutorialSteps.length) {
        const nextAction = tutorialSteps[nextStep].action;
        if (nextAction === 'rotateView') {
          setSphereMode('rotate');
        } else if (nextAction === 'panMode') {
          // Don't auto-switch — let the user click the arrows
        } else if (nextAction === 'zoomMode') {
          // Don't auto-switch — let the user click the arrows
        } else if (nextAction === 'regularSelect') {
          setMode('select');
          setSelectSubMode('regular');
        } else if (nextAction === 'switchToByColor') {
          setMode('select');
          setSelectSubMode('regular');
          // Don't auto-switch — let the user open the dropdown and pick By Color
        } else if (nextAction === 'byColorSelect') {
          setMode('select');
          // byColor was already set by the previous step
        } else if (nextAction === 'marqueeSelect') {
          setMode('select');
          // Don't auto-switch — let the user open the dropdown themselves
        } else if (nextAction === 'changeColor') {
          setMode('select');
          setSelectSubMode('regular');
          // Don't auto-expand palette — let the user click Select Color themselves
        } else if (nextAction === 'delete') {
          setMode('select');
          setSelectSubMode('regular');
        } else if (nextAction === 'paint') {
          // Don't auto-switch — let the user click the paint button
        } else if (nextAction === 'add') {
          // Don't auto-switch — let the user click the add button
        } else if (nextAction === 'resize' && !showResizeScaler) {
          // Skip resize step if not available, go to done
          setTutorialStep(nextStep + 1);
        }
      }
    };
  }, [showTutorial, tutorialStep, selectedColor, colorPalette, showResizeScaler]);

  // Color palette ref for click-outside detection
  const paletteRef = useRef<HTMLDivElement>(null);
  
  // Keep sphereModeRef in sync with sphereMode state
  useEffect(() => {
    sphereModeRef.current = sphereMode;
  }, [sphereMode]);

  // Load color palette on mount
  useEffect(() => {
    fetch('/color-palette.csv')
      .then(res => res.text())
      .then(text => {
        const lines = text.trim().split('\n');
        const colors: PaletteColor[] = [];
        // Skip header
        for (let i = 1; i < lines.length; i++) {
          const [name, hex] = lines[i].split(',');
          if (name && hex) {
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            colors.push({ name: name.trim(), hex: hex.trim(), r, g, b });
          }
        }
        setColorPalette(colors);
      })
      .catch(err => console.error('Failed to load color palette:', err));
  }, []);

  // Handle click outside to collapse palette
  useEffect(() => {
    const handleClickOutside = (event: PointerEvent) => {
      if (paletteExpanded && paletteRef.current && !paletteRef.current.contains(event.target as Node)) {
        setPaletteExpanded(false);
      }
    };

    document.addEventListener('pointerdown', handleClickOutside);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside);
    };
  }, [paletteExpanded]);

  // Initialize selected color with the most common color from xyzrgb data
  useEffect(() => {
    if (!colorPalette || colorPalette.length === 0 || selectedColor) return;
    
    const voxels = parseXyzrgb(xyzrgbContent);
    if (voxels.length === 0) return;

    // Count color occurrences
    const colorCounts = new Map<string, { count: number; r: number; g: number; b: number }>();
    voxels.forEach(voxel => {
      const colorKey = `${voxel.r},${voxel.g},${voxel.b}`;
      const existing = colorCounts.get(colorKey);
      if (existing) {
        existing.count++;
      } else {
        colorCounts.set(colorKey, { count: 1, r: voxel.r, g: voxel.g, b: voxel.b });
      }
    });

    // Find the most common color
    let mostCommonColor: { r: number; g: number; b: number } | null = null;
    let maxCount = 0;
    
    colorCounts.forEach((colorData) => {
      if (colorData.count > maxCount) {
        maxCount = colorData.count;
        mostCommonColor = { r: colorData.r, g: colorData.g, b: colorData.b };
      }
    });

    if (mostCommonColor) {
      // Find the closest matching color in the palette
      let closestColor: PaletteColor | null = null;
      let closestDistance = Infinity;
      
      colorPalette.forEach(paletteColor => {
        const distance = Math.sqrt(
          Math.pow(mostCommonColor!.r - paletteColor.r, 2) +
          Math.pow(mostCommonColor!.g - paletteColor.g, 2) +
          Math.pow(mostCommonColor!.b - paletteColor.b, 2)
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          closestColor = paletteColor;
        }
      });
      
      if (closestColor) {
        setSelectedColor(closestColor);
      }
    }
  }, [xyzrgbContent, colorPalette, selectedColor]);

  // Helper function to push action to history (truncates redo stack)
  const pushToHistory = (action: HistoryAction) => {
    setHistoryStack(prev => {
      // Remove any redo actions (after current index)
      const newStack = prev.slice(0, historyIndexRef.current + 1);
      newStack.push(action);
      return newStack;
    });
    setHistoryIndex(prev => prev + 1);
  };

  // Helper function to rebuild the InstancedMesh and merged edges from current voxel data
  const rebuildInstancedMesh = () => {
    const voxels = voxelsRef.current;
    const voxelGroup = voxelGroupRef.current;
    if (!voxelGroup) return;

    // Clear selection (indices may have shifted)
    selectedIndicesRef.current.clear();
    highlightMeshesRef.current.forEach(h => {
      voxelGroup.remove(h);
      h.geometry.dispose();
      (h.material as THREE.Material).dispose();
    });
    highlightMeshesRef.current = [];
    setSelectionCount(0);

    // Remove old instanced mesh
    if (instancedMeshRef.current) {
      voxelGroup.remove(instancedMeshRef.current);
      disposeInstancedMesh(instancedMeshRef.current);
      instancedMeshRef.current = null;
    }

    // Remove old edges
    if (edgesLineRef.current) {
      voxelGroup.remove(edgesLineRef.current);
      edgesLineRef.current.geometry.dispose();
      (edgesLineRef.current.material as THREE.Material).dispose();
      edgesLineRef.current = null;
    }

    if (voxels.length === 0) return;

    const voxelSize = 1;
    const geometry = createLegoBrickGeometry(voxelSize);
    const material = new THREE.MeshStandardMaterial(LDRAW_PLASTIC_MATERIAL);
    const instancedMesh = new THREE.InstancedMesh(geometry, material, voxels.length);
    instancedMesh.castShadow = true;
    instancedMesh.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    // Build merged edges
    const edgeBoxGeo = new THREE.BoxGeometry(voxelSize, voxelSize, voxelSize * LEGO_HEIGHT);
    const templateEdgeGeo = new THREE.EdgesGeometry(edgeBoxGeo);
    const templatePositions = templateEdgeGeo.getAttribute('position');
    const edgeVertCount = templatePositions.count;
    edgeVertCountRef.current = edgeVertCount;

    const allEdgePositions = new Float32Array(voxels.length * edgeVertCount * 3);
    const allEdgeColors = new Float32Array(voxels.length * edgeVertCount * 3);

    voxels.forEach((voxel, i) => {
      dummy.position.set(voxel.x, voxel.y, voxel.z * LEGO_HEIGHT);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(i, dummy.matrix);
      instancedMesh.setColorAt(i, setVoxelColorFromRgb(color, voxel.r, voxel.g, voxel.b));

      const edgeColorHex = getEdgeColor(voxel.r, voxel.g, voxel.b);
      const ec = new THREE.Color(edgeColorHex);
      for (let j = 0; j < edgeVertCount; j++) {
        const idx = (i * edgeVertCount + j) * 3;
        allEdgePositions[idx] = templatePositions.getX(j) + voxel.x;
        allEdgePositions[idx + 1] = templatePositions.getY(j) + voxel.y;
        allEdgePositions[idx + 2] = templatePositions.getZ(j) + voxel.z * LEGO_HEIGHT;
        allEdgeColors[idx] = ec.r;
        allEdgeColors[idx + 1] = ec.g;
        allEdgeColors[idx + 2] = ec.b;
      }
    });

    instancedMesh.instanceMatrix.needsUpdate = true;
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

    const mergedEdgeGeo = new THREE.BufferGeometry();
    mergedEdgeGeo.setAttribute('position', new THREE.BufferAttribute(allEdgePositions, 3));
    mergedEdgeGeo.setAttribute('color', new THREE.BufferAttribute(allEdgeColors, 3));
    const mergedEdgeMat = new THREE.LineBasicMaterial({ vertexColors: true, opacity: 0.2, transparent: true });
    const mergedEdges = new THREE.LineSegments(mergedEdgeGeo, mergedEdgeMat);

    voxelGroup.add(instancedMesh);
    voxelGroup.add(mergedEdges);

    instancedMeshRef.current = instancedMesh;
    edgesLineRef.current = mergedEdges;

    // Cleanup template geometry
    edgeBoxGeo.dispose();
    templateEdgeGeo.dispose();
  };

  // Helper to update a single voxel's color in the InstancedMesh and merged edges
  const updateInstanceColor = (voxelIndex: number, r: number, g: number, b: number) => {
    const instancedMesh = instancedMeshRef.current;
    if (!instancedMesh) return;

    const color = setVoxelColorFromRgb(new THREE.Color(), r, g, b);
    instancedMesh.setColorAt(voxelIndex, color);
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

    // Update edge color in merged buffer
    const edgesLine = edgesLineRef.current;
    if (edgesLine && edgeVertCountRef.current > 0) {
      const colorAttr = edgesLine.geometry.getAttribute('color');
      const edgeColorHex = getEdgeColor(r, g, b);
      const ec = new THREE.Color(edgeColorHex);
      const startVert = voxelIndex * edgeVertCountRef.current;
      for (let j = 0; j < edgeVertCountRef.current; j++) {
        colorAttr.setXYZ(startVert + j, ec.r, ec.g, ec.b);
      }
      (colorAttr as THREE.BufferAttribute).needsUpdate = true;
    }
  };

  // Check if undo/redo is available
  const canUndo = historyIndex >= 0;
  const canRedo = historyIndex < historyStack.length - 1;

  // Undo action
  const handleUndo = () => {
    if (!canUndo) return;
    
    const action = historyStack[historyIndex];
    
    if (action.type === 'colorChange') {
      // Revert colors to old values
      action.voxelIndices.forEach((voxelIndex, i) => {
        const oldColor = action.oldColors[i];
        const voxel = voxelsRef.current[voxelIndex];
        if (voxel) {
          voxel.r = oldColor.r;
          voxel.g = oldColor.g;
          voxel.b = oldColor.b;
          updateInstanceColor(voxelIndex, oldColor.r, oldColor.g, oldColor.b);
        }
      });
    } else if (action.type === 'addVoxel') {
      // Remove the added voxel
      voxelsRef.current.splice(action.index, 1);
      rebuildInstancedMesh();
    } else if (action.type === 'deleteVoxels') {
      // Re-add the deleted voxels at their original indices (in ascending order)
      action.indices.forEach((originalIndex, i) => {
        voxelsRef.current.splice(originalIndex, 0, { ...action.voxels[i] });
      });
      rebuildInstancedMesh();
    }
    
    setHistoryIndex(prev => prev - 1);
    markChanged();
    setSaveError(null);
    
    // Advance tutorial
    advanceTutorialRef.current('undo');
    
    // Notify parent of changes
    if (onVoxelsChange) {
      const newContent = voxelsRef.current
        .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
        .join('\n');
      onVoxelsChange(newContent);
    }
  };

  // Redo action
  const handleRedo = () => {
    if (!canRedo) return;
    
    const action = historyStack[historyIndex + 1];
    
    if (action.type === 'colorChange') {
      // Apply new colors
      action.voxelIndices.forEach((voxelIndex, i) => {
        const newColor = action.newColors[i];
        const voxel = voxelsRef.current[voxelIndex];
        if (voxel) {
          voxel.r = newColor.r;
          voxel.g = newColor.g;
          voxel.b = newColor.b;
          updateInstanceColor(voxelIndex, newColor.r, newColor.g, newColor.b);
        }
      });
    } else if (action.type === 'addVoxel') {
      // Re-add the voxel
      voxelsRef.current.push({ ...action.voxel });
      rebuildInstancedMesh();
    } else if (action.type === 'deleteVoxels') {
      // Re-delete the voxels (in descending order of indices)
      const indicesToRemove = [...action.indices].sort((a, b) => b - a);
      indicesToRemove.forEach(index => {
        voxelsRef.current.splice(index, 1);
      });
      rebuildInstancedMesh();
    }
    
    setHistoryIndex(prev => prev + 1);
    markChanged();
    setSaveError(null);
    
    // Notify parent of changes
    if (onVoxelsChange) {
      const newContent = voxelsRef.current
        .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
        .join('\n');
      onVoxelsChange(newContent);
    }
  };

  // Apply selected color to selected voxels
  const applyColorToSelection = (color: PaletteColor) => {
    if (selectedIndicesRef.current.size === 0) return;

    // Collect old colors for history
    const voxelIndices: number[] = [];
    const oldColors: { r: number; g: number; b: number }[] = [];
    const newColors: { r: number; g: number; b: number }[] = [];

    selectedIndicesRef.current.forEach(voxelIndex => {
      const voxel = voxelsRef.current[voxelIndex];
      if (voxel) {
        voxelIndices.push(voxelIndex);
        oldColors.push({ r: voxel.r, g: voxel.g, b: voxel.b });
        newColors.push({ r: color.r, g: color.g, b: color.b });
      }
    });

    // Push to history
    pushToHistory({ type: 'colorChange', voxelIndices, oldColors, newColors });

    selectedIndicesRef.current.forEach(voxelIndex => {
      const voxel = voxelsRef.current[voxelIndex];
      if (voxel) {
        voxel.r = color.r;
        voxel.g = color.g;
        voxel.b = color.b;
        updateInstanceColor(voxelIndex, color.r, color.g, color.b);
      }
    });

    // Mark as having changes
    markChanged();
    setSaveError(null);

    // Advance tutorial
    advanceTutorialRef.current('changeColor');

    // Notify parent of changes
    if (onVoxelsChange) {
      const newContent = voxelsRef.current
        .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
        .join('\n');
      onVoxelsChange(newContent);
    }
  };

  // Delete selected voxels
  const deleteSelectedVoxels = () => {
    if (selectedIndicesRef.current.size === 0) return;
    
    // Collect voxels for history (sorted ascending for restore order)
    const sortedIndices = [...selectedIndicesRef.current].sort((a, b) => a - b);
    const voxelsToDelete = sortedIndices.map(idx => ({ ...voxelsRef.current[idx] }));
    
    // Push to history
    pushToHistory({ 
      type: 'deleteVoxels', 
      voxels: voxelsToDelete, 
      indices: sortedIndices 
    });
    
    // Remove from voxelsRef (descending order to preserve indices)
    const descendingIndices = [...sortedIndices].reverse();
    descendingIndices.forEach(index => {
      voxelsRef.current.splice(index, 1);
    });
    
    // Rebuild instanced mesh (also clears selection)
    rebuildInstancedMesh();
    
    // Mark as having changes
    markChanged();
    setSaveError(null);
    
    // Notify parent
    onVoxelSelect?.(null, null);
    
    // Advance tutorial
    advanceTutorialRef.current('delete');
    
    if (onVoxelsChange) {
      const newContent = voxelsRef.current
        .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
        .join('\n');
      onVoxelsChange(newContent);
    }
  };

  // Render the current voxel scene to a clean PNG data URL. Selection and
  // problematic highlights are hidden so they don't appear in the preview.
  const capturePreview = (): string | null => {
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return null;

    const hidden: THREE.Object3D[] = [];
    const hide = (obj: THREE.Object3D | null | undefined) => {
      if (obj && obj.visible) {
        obj.visible = false;
        hidden.push(obj);
      }
    };
    highlightMeshesRef.current.forEach(hide);
    problematicHighlightsRef.current.forEach(hide);

    try {
      return captureTransparentPreview(renderer, scene, camera);
    } catch (err) {
      console.warn('Failed to capture voxel preview:', err);
      return null;
    } finally {
      hidden.forEach((obj) => {
        obj.visible = true;
      });
      renderer.render(scene, camera);
    }
  };

  // Save changes to backend
  const handleSave = async () => {
    if (!generationId) {
      setSaveError('No generation ID provided');
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    const savingVersion = changeVersionRef.current;

    try {
      const xyzrgbContent = voxelsRef.current
        .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
        .join('\n');

      const response = await UpdateModelApiService.updateModel(
        generationId,
        xyzrgbContent,
        accessToken
      );

      if (response.generation_id) {
        // Keep the editor dirty if another edit landed while this request was
        // in flight so that change is included in the next autosave.
        if (changeVersionRef.current === savingVersion) {
          setHasChanges(false);
        }
        advanceTutorialRef.current('save');
        if (onSaveSuccess) {
          await onSaveSuccess(response);
        }
      } else {
        setSaveError('No generation ID returned from save');
      }
    } catch (error) {
      console.error('Failed to save model:', error);
      setSaveError(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setIsSaving(false);
    }
  };

  useDirtyAutosave({
    hasChanges,
    isSaving: isSaving || Boolean(isProcessingSave),
    onSave: handleSave,
  });

  // Update mode ref when mode changes
  useEffect(() => {
    modeRef.current = mode;
    // Update controls based on mode
    if (controlsRef.current) {
      // Pan mode: left-click to pan, other modes: left-click disabled (used for selection)
      // Right-click always rotates, middle-click always pans
      controlsRef.current.mouseButtons = {
        LEFT: mode === 'pan' ? THREE.MOUSE.PAN : undefined as unknown as THREE.MOUSE,
        MIDDLE: THREE.MOUSE.PAN,
        RIGHT: THREE.MOUSE.ROTATE
      };
      // Update touch behavior: pan mode uses one-finger pan, other modes disable one-finger for selection
      // Two-finger always rotates + zooms
      controlsRef.current.touches = {
        ONE: mode === 'pan' ? THREE.TOUCH.PAN : undefined as unknown as THREE.TOUCH,
        TWO: THREE.TOUCH.DOLLY_ROTATE
      };
    }
  }, [mode]);

  // Update selectSubMode ref when it changes
  useEffect(() => {
    selectSubModeRef.current = selectSubMode;
  }, [selectSubMode]);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf5f0e8);
    sceneRef.current = scene;

    // Create camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    cameraRef.current = camera;

    // Create renderer with accurate color output. preserveDrawingBuffer lets
    // us read the canvas via toDataURL() for preview capture after a save.
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.85;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment()).texture;

    // Create controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    // Right-click to rotate, middle-click to pan
    controls.mouseButtons = {
      LEFT: undefined as unknown as THREE.MOUSE,  // Disable left-click for controls (used for selection)
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE
    };
    // Disable one-finger touch (we handle it for selection), two-finger for rotate/zoom
    controls.touches = {
      ONE: undefined as unknown as THREE.TOUCH,  // Disable one-finger for controls (used for selection)
      TWO: THREE.TOUCH.DOLLY_ROTATE
    };
    controlsRef.current = controls;

    const keyLight = new THREE.DirectionalLight(0xfff5e6, 0.8);
    keyLight.position.set(200, 400, 200);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.width = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 2000;
    keyLight.shadow.camera.left = -500;
    keyLight.shadow.camera.right = 500;
    keyLight.shadow.camera.top = 500;
    keyLight.shadow.camera.bottom = -500;
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xe8f0ff, 0.3);
    fillLight.position.set(-150, 200, -100);
    scene.add(fillLight);

    const ambient = new THREE.AmbientLight(0xffffff, 0.15);
    scene.add(ambient);

    // Parse voxels
    const voxels = parseXyzrgb(xyzrgbContent);
    voxelsRef.current = voxels;
    selectedIndicesRef.current = new Set();

    if (voxels.length > 0) {
      // Create a group to hold all voxel meshes
      const voxelGroup = new THREE.Group();
      voxelGroupRef.current = voxelGroup;

      // Build InstancedMesh and merged edges (single draw call each)
      rebuildInstancedMesh();

      // Rotate the model so studs face upward (Z-up data to Y-up display)
      voxelGroup.rotation.x = -Math.PI / 2;

      scene.add(voxelGroup);

      // Center the camera on the voxel group
      const box = new THREE.Box3().setFromObject(voxelGroup);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      buildVoxelDisplayRoom(scene, box, center, maxDim);
      
      camera.position.set(
        center.x + maxDim * 1.5,
        center.y + maxDim * 1.0,
        center.z + maxDim * 1.5
      );
      controls.target.copy(center);
      controls.update();

      // Problematic highlights are handled in a separate effect
    }

    // Create highlight geometry for selections (match LEGO brick dimensions - height along Z)
    const highlightGeometry = new THREE.BoxGeometry(1.1, 1.1, 1.1 * LEGO_HEIGHT);
    const highlightMaterial = new THREE.MeshBasicMaterial({ 
      color: 0x00ff00, 
      wireframe: true,
      wireframeLinewidth: 2
    });

    // Helper function to clear all selections
    const clearSelection = () => {
      selectedIndicesRef.current.clear();
      
      // Remove all highlight meshes
      highlightMeshesRef.current.forEach(highlight => {
        if (voxelGroupRef.current) {
          voxelGroupRef.current.remove(highlight);
        }
        highlight.geometry.dispose();
        (highlight.material as THREE.Material).dispose();
      });
      highlightMeshesRef.current = [];
      setSelectionCount(0);
    };

    // Helper function to select a voxel by index
    const selectVoxel = (index: number) => {
      if (selectedIndicesRef.current.has(index)) return; // Already selected
      selectedIndicesRef.current.add(index);
      setSelectionCount(selectedIndicesRef.current.size);
      
      // Add green wireframe highlight
      const voxel = voxelsRef.current[index];
      if (voxelGroupRef.current && voxel) {
        const highlight = new THREE.Mesh(highlightGeometry.clone(), highlightMaterial.clone());
        highlight.position.set(voxel.x, voxel.y, voxel.z * LEGO_HEIGHT);
        highlight.userData.forIndex = index; // Track which voxel index this highlight belongs to
        voxelGroupRef.current.add(highlight);
        highlightMeshesRef.current.push(highlight);
      }
    };
    
    // Helper function to unselect a voxel by index
    const unselectVoxel = (index: number) => {
      if (!selectedIndicesRef.current.has(index)) return; // Not selected
      selectedIndicesRef.current.delete(index);
      setSelectionCount(selectedIndicesRef.current.size);
      
      // Remove the highlight for this voxel
      if (voxelGroupRef.current) {
        const highlightIndex = highlightMeshesRef.current.findIndex(h => h.userData.forIndex === index);
        if (highlightIndex !== -1) {
          const highlight = highlightMeshesRef.current[highlightIndex];
          voxelGroupRef.current.remove(highlight);
          highlight.geometry.dispose();
          (highlight.material as THREE.Material).dispose();
          highlightMeshesRef.current.splice(highlightIndex, 1);
        }
      }
    };
    
    // Helper function to toggle voxel selection
    const toggleVoxelSelection = (index: number) => {
      if (selectedIndicesRef.current.has(index)) {
        unselectVoxel(index);
      } else {
        selectVoxel(index);
      }
    };

    // Helper function to add a voxel at a position
    const addVoxelAtPosition = (x: number, y: number, z: number, r: number, g: number, b: number) => {
      // Check if voxel already exists at this position
      const exists = voxelsRef.current.some(v => v.x === x && v.y === y && v.z === z);
      if (exists) return;
      
      // Create the new voxel data
      const newVoxel: Voxel = { x, y, z, r, g, b };
      const newIndex = voxelsRef.current.length;
      
      // Push to history
      pushToHistory({ type: 'addVoxel', voxel: { ...newVoxel }, index: newIndex });
      
      voxelsRef.current.push(newVoxel);
      rebuildInstancedMesh();
      
      // Mark as having changes
      markChanged();
      setSaveError(null);
      advanceTutorialRef.current('add');
      
      // Notify parent of changes
      if (onVoxelsChange) {
        const newContent = voxelsRef.current
          .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
          .join('\n');
        onVoxelsChange(newContent);
      }
    };

    // Helper function to paint a voxel with a new color (by index)
    const paintVoxel = (voxelIndex: number, r: number, g: number, b: number) => {
      const voxel = voxelsRef.current[voxelIndex];
      if (!voxel) return;
      
      // Skip if color is already the same
      if (voxel.r === r && voxel.g === g && voxel.b === b) return;
      
      // Track for paint stroke history (only store original color once per voxel in stroke)
      if (!paintStrokeRef.current.has(voxelIndex)) {
        paintStrokeRef.current.set(voxelIndex, {
          oldColor: { r: voxel.r, g: voxel.g, b: voxel.b },
          newColor: { r, g, b }
        });
      } else {
        // Update the new color for this voxel if we paint it again in the same stroke
        paintStrokeRef.current.get(voxelIndex)!.newColor = { r, g, b };
      }
      
      // Update the voxel data
      voxel.r = r;
      voxel.g = g;
      voxel.b = b;
      
      // Update instance color (single voxel, no rebuild needed)
      updateInstanceColor(voxelIndex, r, g, b);
      
      // Mark as having changes
      markChanged();
      setSaveError(null);
      
      // Notify parent of changes
      if (onVoxelsChange) {
        const newContent = voxelsRef.current
          .map(v => `${v.x} ${v.y} ${v.z} ${v.r} ${v.g} ${v.b}`)
          .join('\n');
        onVoxelsChange(newContent);
      }
    };
    
    // Helper function to commit paint stroke to history
    const commitPaintStroke = () => {
      if (paintStrokeRef.current.size === 0) return;
      
      const voxelIndices: number[] = [];
      const oldColors: { r: number; g: number; b: number }[] = [];
      const newColors: { r: number; g: number; b: number }[] = [];
      
      paintStrokeRef.current.forEach((value, index) => {
        voxelIndices.push(index);
        oldColors.push(value.oldColor);
        newColors.push(value.newColor);
      });
      
      pushToHistory({ type: 'colorChange', voxelIndices, oldColors, newColors });
      paintStrokeRef.current.clear();
      advanceTutorialRef.current('paint');
    };

    // Helper to get voxel screen position by index
    const getScreenPosition = (index: number): { x: number; y: number } | null => {
      if (!cameraRef.current || !containerRef.current || !voxelGroupRef.current) return null;
      
      const voxel = voxelsRef.current[index];
      if (!voxel) return null;
      
      // Get position and apply parent group transformation
      const worldPos = new THREE.Vector3(voxel.x, voxel.y, voxel.z * LEGO_HEIGHT);
      worldPos.applyMatrix4(voxelGroupRef.current.matrixWorld);
      
      // Project to screen
      const projected = worldPos.clone().project(cameraRef.current);
      
      // Check if behind camera
      if (projected.z > 1) return null;
      
      const rect = containerRef.current.getBoundingClientRect();
      return {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((-projected.y + 1) / 2) * rect.height
      };
    };

    // Marquee selection handlers - use Pointer Events to unify mouse/touch and avoid duplicate events
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return; // Only left click/primary touch
      if (modeRef.current !== 'select' && modeRef.current !== 'add' && modeRef.current !== 'paint') return;
      if (!containerRef.current) return;
      
      // Capture pointer to receive all events even if pointer leaves the element
      (event.target as HTMLElement).setPointerCapture(event.pointerId);
      
      const rect = containerRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      // Handle paint mode - paint voxel on click
      if (modeRef.current === 'paint') {
        if (!cameraRef.current) return;
        
        const mouse = new THREE.Vector2();
        mouse.x = (x / rect.width) * 2 - 1;
        mouse.y = -(y / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, cameraRef.current);
        
        if (instancedMeshRef.current) {
          const intersects = raycaster.intersectObject(instancedMeshRef.current);
          if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
            const colorToUse = paintColorRef.current || { r: 128, g: 128, b: 128 };
            paintVoxel(intersects[0].instanceId, colorToUse.r, colorToUse.g, colorToUse.b);
          }
        }
        
        // Track for drag painting
        selectionStartRef.current = { x, y };
        return;
      }
      
      // Handle add mode - add voxel on face click
      if (modeRef.current === 'add') {
        if (!cameraRef.current) return;
        
        const mouse = new THREE.Vector2();
        mouse.x = (x / rect.width) * 2 - 1;
        mouse.y = -(y / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, cameraRef.current);
        
        if (instancedMeshRef.current) {
          const intersects = raycaster.intersectObject(instancedMeshRef.current);
          if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
            const intersection = intersects[0];
            const face = intersection.face;
            
            if (face) {
              // Get the face normal in local space
              const normal = face.normal.clone();
              
              // Round to nearest axis (face normals should be axis-aligned for a box)
              const nx = Math.round(normal.x);
              const ny = Math.round(normal.y);
              const nz = Math.round(normal.z);
              
              // Get the original voxel data coordinates
              const hitVoxel = voxelsRef.current[intersection.instanceId!];
              
              // Calculate new voxel position in data coordinates (not display coordinates)
              // nz maps to data z: divide by LEGO_HEIGHT to reverse the display scaling
              const newX = hitVoxel.x + nx;
              const newY = hitVoxel.y + ny;
              const newZ = hitVoxel.z + (nz !== 0 ? (nz > 0 ? 1 : -1) : 0);
              
              // Get color from addColor state or default to gray
              const colorToUse = addColorRef.current || { r: 128, g: 128, b: 128 };
              
              addVoxelAtPosition(newX, newY, newZ, colorToUse.r, colorToUse.g, colorToUse.b);
            }
          }
        }
        return;
      }
      
      // For regular (brush) mode, clear selection on mouse down (unless shift held) and select initial voxel
      if (selectSubModeRef.current === 'regular') {
        if (!event.shiftKey) {
          clearSelection();
        }
        
        // Select voxel under cursor
        if (cameraRef.current) {
          const mouse = new THREE.Vector2();
          mouse.x = (x / rect.width) * 2 - 1;
          mouse.y = -(y / rect.height) * 2 + 1;
          
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(mouse, cameraRef.current);
          
          if (instancedMeshRef.current) {
            const intersects = raycaster.intersectObject(instancedMeshRef.current);
            if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
              selectVoxel(intersects[0].instanceId);
            }
          }
        }
      }
      
      selectionStartRef.current = { x, y };
      setSelectionStart({ x, y });
      setSelectionEnd({ x, y });
      setIsSelecting(true);
    };

    const handlePointerMove = (event: PointerEvent) => {
      // Handle paint mode drag
      if (modeRef.current === 'paint') {
        if (!containerRef.current || !selectionStartRef.current || !cameraRef.current) return;
        
        const rect = containerRef.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const mouse = new THREE.Vector2();
        mouse.x = (x / rect.width) * 2 - 1;
        mouse.y = -(y / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, cameraRef.current);
        
        if (instancedMeshRef.current) {
          const intersects = raycaster.intersectObject(instancedMeshRef.current);
          if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
            const colorToUse = paintColorRef.current || { r: 128, g: 128, b: 128 };
            paintVoxel(intersects[0].instanceId, colorToUse.r, colorToUse.g, colorToUse.b);
          }
        }
        return;
      }
      
      if (modeRef.current !== 'select') return; // Only in select mode
      if (!containerRef.current || !selectionStartRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      
      // Regular (brush) select mode - select voxels as we drag
      if (selectSubModeRef.current === 'regular' && cameraRef.current) {
        const mouse = new THREE.Vector2();
        mouse.x = (x / rect.width) * 2 - 1;
        mouse.y = -(y / rect.height) * 2 + 1;
        
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, cameraRef.current);
        
        if (instancedMeshRef.current) {
          const intersects = raycaster.intersectObject(instancedMeshRef.current);
          if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
            const instanceId = intersects[0].instanceId;
            // Only select if not already selected
            if (!selectedIndicesRef.current.has(instanceId)) {
              selectVoxel(instanceId);
            }
          }
        }
      }
      
      setSelectionEnd({ x, y });
    };

    const handlePointerUp = (event: PointerEvent) => {
      // Release pointer capture
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
      
      // Handle paint mode pointer up
      if (modeRef.current === 'paint') {
        commitPaintStroke();
        selectionStartRef.current = null;
        return;
      }
      
      if (event.button !== 0) return; // Only left click
      if (modeRef.current !== 'select') return; // Only in select mode
      if (!containerRef.current || !cameraRef.current) return;
      
      setIsSelecting(false);
      
      // For regular (brush) mode, just report the current selection
      if (selectSubModeRef.current === 'regular') {
        const selectedVoxels: Voxel[] = [];
        const selectedIdxList: number[] = [];
        
        selectedIndicesRef.current.forEach((index) => {
          selectedVoxels.push(voxelsRef.current[index]);
          selectedIdxList.push(index);
        });
        
        if (selectedVoxels.length > 0) {
          onVoxelSelect?.(selectedVoxels, selectedIdxList);
          advanceTutorialRef.current('regularSelect');
        } else {
          onVoxelSelect?.(null, null);
        }
        
        selectionStartRef.current = null;
        setSelectionStart(null);
        setSelectionEnd(null);
        return;
      }
      
      const rect = containerRef.current.getBoundingClientRect();
      const endX = event.clientX - rect.left;
      const endY = event.clientY - rect.top;
      
      // Only clear previous selection if shift is NOT held
      if (!event.shiftKey) {
        clearSelection();
      }
      
      const startPos = selectionStartRef.current;
      if (startPos) {
        const minX = Math.min(startPos.x, endX);
        const maxX = Math.max(startPos.x, endX);
        const minY = Math.min(startPos.y, endY);
        const maxY = Math.max(startPos.y, endY);
        
        const isClick = Math.abs(maxX - minX) < 5 && Math.abs(maxY - minY) < 5;
        
        if (isClick) {
          // Single click - use raycasting
          const mouse = new THREE.Vector2();
          mouse.x = ((endX) / rect.width) * 2 - 1;
          mouse.y = -((endY) / rect.height) * 2 + 1;
          
          const raycaster = new THREE.Raycaster();
          raycaster.setFromCamera(mouse, cameraRef.current);
          
          if (instancedMeshRef.current) {
            const intersects = raycaster.intersectObject(instancedMeshRef.current);
          
            if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
              const voxelIndex = intersects[0].instanceId;
              const clickedVoxel = voxelsRef.current[voxelIndex];
            
              // Check if we're in "select by color" mode
              if (selectSubModeRef.current === 'byColor') {
                // Select all voxels with the same color
                const targetR = clickedVoxel.r;
                const targetG = clickedVoxel.g;
                const targetB = clickedVoxel.b;
              
                const sameColorVoxels: Voxel[] = [];
                const sameColorIndices: number[] = [];
              
                voxelsRef.current.forEach((voxel, idx) => {
                  if (voxel.r === targetR && voxel.g === targetG && voxel.b === targetB) {
                    sameColorVoxels.push(voxel);
                    sameColorIndices.push(idx);
                    if (event.shiftKey) {
                      toggleVoxelSelection(idx);
                    } else {
                      selectVoxel(idx);
                    }
                  }
                });
              
                onVoxelSelect?.(sameColorVoxels, sameColorIndices);
              advanceTutorialRef.current('byColorSelect');
              } else {
                // Regular single select - toggle if shift held
                if (event.shiftKey) {
                  toggleVoxelSelection(voxelIndex);
                } else {
                  selectVoxel(voxelIndex);
                }
                onVoxelSelect?.([clickedVoxel], [voxelIndex]);
              }
            } else {
              onVoxelSelect?.(null, null);
            }
          } else {
            onVoxelSelect?.(null, null);
          }
        } else if (selectSubModeRef.current === 'marquee') {
          // Marquee selection - only in marquee mode - select all voxels fully within the marquee
          const selectedVoxels: Voxel[] = [];
          const selectedIndices: number[] = [];
          
          // Helper to project a point to screen coordinates
          const projectToScreen = (pos: THREE.Vector3): { x: number; y: number } | null => {
            if (!cameraRef.current || !voxelGroupRef.current) return null;
            
            const worldPos = pos.clone();
            worldPos.applyMatrix4(voxelGroupRef.current.matrixWorld);
            const projected = worldPos.clone().project(cameraRef.current);
            
            // Behind camera check
            if (projected.z > 1) return null;
            
            return {
              x: ((projected.x + 1) / 2) * rect.width,
              y: ((-projected.y + 1) / 2) * rect.height
            };
          };
          
          // Check each voxel - all corners must be within marquee
          voxelsRef.current.forEach((voxel, index) => {
            const pos = new THREE.Vector3(voxel.x, voxel.y, voxel.z * LEGO_HEIGHT);
            const halfSize = 0.5;
            
            // Get all 8 corners of the voxel
            const corners = [
              new THREE.Vector3(pos.x - halfSize, pos.y - halfSize, pos.z - halfSize),
              new THREE.Vector3(pos.x + halfSize, pos.y - halfSize, pos.z - halfSize),
              new THREE.Vector3(pos.x - halfSize, pos.y + halfSize, pos.z - halfSize),
              new THREE.Vector3(pos.x + halfSize, pos.y + halfSize, pos.z - halfSize),
              new THREE.Vector3(pos.x - halfSize, pos.y - halfSize, pos.z + halfSize),
              new THREE.Vector3(pos.x + halfSize, pos.y - halfSize, pos.z + halfSize),
              new THREE.Vector3(pos.x - halfSize, pos.y + halfSize, pos.z + halfSize),
              new THREE.Vector3(pos.x + halfSize, pos.y + halfSize, pos.z + halfSize),
            ];
            
            // Check if all corners are within the marquee
            let allCornersInside = true;
            for (const corner of corners) {
              const screenPos = projectToScreen(corner);
              if (!screenPos || 
                  screenPos.x < minX || screenPos.x > maxX ||
                  screenPos.y < minY || screenPos.y > maxY) {
                allCornersInside = false;
                break;
              }
            }
            
            if (allCornersInside) {
              selectVoxel(index);
              selectedVoxels.push(voxel);
              selectedIndices.push(index);
            }
          });
          
          if (selectedVoxels.length > 0) {
            onVoxelSelect?.(selectedVoxels, selectedIndices);
            advanceTutorialRef.current('marqueeSelect');
          } else {
            onVoxelSelect?.(null, null);
          }
        }
      }
      
      selectionStartRef.current = null;
      setSelectionStart(null);
      setSelectionEnd(null);
    };

    // Use Pointer Events for unified mouse/touch handling (avoids duplicate events on mobile)
    container.addEventListener('pointerdown', handlePointerDown);
    container.addEventListener('pointermove', handlePointerMove);
    container.addEventListener('pointerup', handlePointerUp);

    // Animation loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      controls.update();

      // Hide the table when the camera rotates below the table's top surface so
      // the model's underside stays visible (mirrors the LDraw 3D viewer).
      const displayTable = scene.getObjectByName('display-table');
      if (displayTable) {
        const hideBelowY = typeof displayTable.userData.hideBelowY === 'number'
          ? displayTable.userData.hideBelowY
          : controls.target.y;
        const isUnderModel = camera.position.y < hideBelowY - 1;
        displayTable.visible = !isUnderModel;
      }

      renderer.render(scene, camera);
    };
    animate();

    // Handle resize
    const handleResize = () => {
      if (!containerRef.current) return;
      const newWidth = containerRef.current.clientWidth;
      const newHeight = containerRef.current.clientHeight;
      
      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(newWidth, newHeight);
    };
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('pointerdown', handlePointerDown);
      container.removeEventListener('pointermove', handlePointerMove);
      container.removeEventListener('pointerup', handlePointerUp);
      cancelAnimationFrame(animationFrameRef.current);
      
      // Clean up instanced mesh
      if (instancedMeshRef.current) {
        disposeInstancedMesh(instancedMeshRef.current);
        instancedMeshRef.current = null;
      }
      
      // Clean up merged edges
      if (edgesLineRef.current) {
        edgesLineRef.current.geometry.dispose();
        (edgesLineRef.current.material as THREE.Material).dispose();
        edgesLineRef.current = null;
      }
      
      // Clean up highlight meshes
      highlightMeshesRef.current.forEach(highlight => {
        highlight.geometry.dispose();
        (highlight.material as THREE.Material).dispose();
      });
      highlightMeshesRef.current = [];
      
      if (rendererRef.current && containerRef.current) {
        containerRef.current.removeChild(rendererRef.current.domElement);
        rendererRef.current.dispose();
      }
      
      if (controlsRef.current) {
        controlsRef.current.dispose();
      }

      pmremGenerator.dispose();
    };
  }, [xyzrgbContent, onVoxelSelect]);

  // Separate effect for problematic voxel highlights — updates without tearing down the editor
  useEffect(() => {
    const voxelGroup = voxelGroupRef.current;
    if (!voxelGroup) return;

    // Clean up previous problematic highlights
    problematicHighlightsRef.current.forEach(highlight => {
      voxelGroup.remove(highlight);
      highlight.geometry.dispose();
      (highlight.material as THREE.Material).dispose();
    });
    problematicHighlightsRef.current = [];

    if (problematicXyzrgbContent) {
      const problematicVoxels = parseXyzrgb(problematicXyzrgbContent);

      const problematicPositions = new Set<string>();
      problematicVoxels.forEach(pv => {
        problematicPositions.add(`${pv.x},${pv.y},${pv.z}`);
      });

      const problematicHighlightGeometry = new THREE.BoxGeometry(1.15, 1.15, 1.15 * LEGO_HEIGHT);
      const problematicHighlightMaterial = new THREE.MeshBasicMaterial({
        color: 0xff0000,
        wireframe: true,
        wireframeLinewidth: 2
      });

      voxelsRef.current.forEach((voxel) => {
        const posKey = `${voxel.x},${voxel.y},${voxel.z}`;
        if (problematicPositions.has(posKey)) {
          const highlight = new THREE.Mesh(
            problematicHighlightGeometry.clone(),
            problematicHighlightMaterial.clone()
          );
          highlight.position.set(voxel.x, voxel.y, voxel.z * LEGO_HEIGHT);
          voxelGroup.add(highlight);
          problematicHighlightsRef.current.push(highlight);
        }
      });
    }
  }, [problematicXyzrgbContent]);

  // Keyboard event listener for delete/backspace and undo/redo
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't process if user is typing in an input
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      // Undo: Ctrl+Z or Cmd+Z
      if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
        return;
      }
      
      // Redo: Ctrl+Shift+Z or Cmd+Shift+Z or Ctrl+Y or Cmd+Y
      if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.key === 'z' && event.shiftKey))) {
        event.preventDefault();
        handleRedo();
        return;
      }
      
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteSelectedVoxels();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo]);

  // Calculate marquee box style
  const getMarqueeStyle = (): React.CSSProperties | undefined => {
    if (!isSelecting || !selectionStart || !selectionEnd) return undefined;
    
    const left = Math.min(selectionStart.x, selectionEnd.x);
    const top = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);
    
    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      border: '2px dashed #00ff00',
      backgroundColor: 'rgba(0, 255, 0, 0.1)',
      pointerEvents: 'none',
      zIndex: 1000,
    };
  };

  // Get cursor based on mode
  const getCursor = () => {
    switch (mode) {
      case 'select': return 'crosshair';
      case 'pan': return 'grab';
      case 'add': return 'cell';
      case 'paint': return 'crosshair';
      default: return 'crosshair';
    }
  };

  // Draw sphere rotator on canvas with 3D sphere (for all modes)
  useEffect(() => {
    const canvas = sphereCanvasRef.current;
    if (!canvas) return;
    
    const size = 80;
    
    // Create a mini Three.js scene for the sphere
    const miniScene = new THREE.Scene();
    miniScene.background = new THREE.Color(0xdeebed);
    
    const miniCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    miniCamera.position.set(0, 0, 3);
    
    const miniRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    miniRenderer.setSize(size, size);
    miniRenderer.setPixelRatio(window.devicePixelRatio);
    
    // Create sphere geometry with minimal wireframe (8 segments instead of 16)
    const sphereGeometry = new THREE.SphereGeometry(0.8, 8, 8);
    const sphereMaterial = new THREE.MeshBasicMaterial({ 
      color: 0x8B5CF6,
      wireframe: true,
      transparent: true,
      opacity: 0.8
    });
    const sphereMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
    miniScene.add(sphereMesh);
    
    // Animation loop to sync sphere with main camera/interaction
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      
      if (sphereModeRef.current === 'rotate') {
        // Sync sphere rotation with main camera
        if (cameraRef.current && controlsRef.current) {
          const mainCamera = cameraRef.current;
          const target = controlsRef.current.target;
          
          // Get camera direction
          const offset = new THREE.Vector3().subVectors(mainCamera.position, target);
          const spherical = new THREE.Spherical().setFromVector3(offset);
          
          // Apply inverted rotation to sphere (matches the feel of dragging)
          sphereMesh.rotation.y = spherical.theta;
          sphereMesh.rotation.x = -spherical.phi + Math.PI / 2;
        }
        
        // Reset position and scale
        sphereMesh.position.set(0, 0, 0);
        sphereMesh.scale.set(1, 1, 1);
      } else if (sphereModeRef.current === 'pan') {
        // Move sphere position based on pan drag
        if (isDraggingSphere && sphereDragStartRef.current && sphereDragCurrentRef.current) {
          const deltaX = sphereDragCurrentRef.current.x - sphereDragStartRef.current.x;
          const deltaY = sphereDragCurrentRef.current.y - sphereDragStartRef.current.y;
          
          // Scale movement to fit in the mini canvas
          const moveScale = 0.015;
          const maxOffset = 1.0; // Maximum distance sphere can move from center
          
          // Calculate position and clamp to max offset
          const newX = THREE.MathUtils.clamp(deltaX * moveScale, -maxOffset, maxOffset);
          const newY = THREE.MathUtils.clamp(-deltaY * moveScale, -maxOffset, maxOffset);
          
          sphereMesh.position.x = newX;
          sphereMesh.position.y = newY;
        } else {
          // Reset to center when not dragging
          sphereMesh.position.set(0, 0, 0);
        }
        
        // Reset rotation and scale
        sphereMesh.rotation.set(0, 0, 0);
        sphereMesh.scale.set(1, 1, 1);
      } else if (sphereModeRef.current === 'zoom') {
        // Scale sphere based on zoom drag
        if (isDraggingSphere && sphereDragStartRef.current && sphereDragCurrentRef.current) {
          const deltaY = sphereDragCurrentRef.current.y - sphereDragStartRef.current.y;
          
          // Calculate scale factor (zoom out = smaller sphere, zoom in = larger sphere)
          const zoomSpeed = 0.01;
          const scaleFactor = 1 - deltaY * zoomSpeed;
          const clampedScale = THREE.MathUtils.clamp(scaleFactor, 0.3, 2.0);
          
          sphereMesh.scale.set(clampedScale, clampedScale, clampedScale);
        } else {
          // Reset to normal scale when not dragging
          sphereMesh.scale.set(1, 1, 1);
        }
        
        // Reset position and rotation
        sphereMesh.position.set(0, 0, 0);
        sphereMesh.rotation.set(0, 0, 0);
      }
      
      miniRenderer.render(miniScene, miniCamera);
    };
    animate();
    
    // Cleanup
    return () => {
      cancelAnimationFrame(animationId);
      miniRenderer.dispose();
      sphereGeometry.dispose();
      sphereMaterial.dispose();
    };
  }, [sphereMode, isDraggingSphere]);

  // Handle sphere rotation/pan/zoom drag
  const handleSpherePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation();
    setIsDraggingSphere(true);
    sphereDragStartRef.current = { x: event.clientX, y: event.clientY };
    sphereDragCurrentRef.current = { x: event.clientX, y: event.clientY };
    
    if (controlsRef.current && cameraRef.current) {
      const controls = controlsRef.current;
      const camera = cameraRef.current;
      const target = controls.target;
      
      if (sphereModeRef.current === 'rotate') {
        // Store initial camera spherical coordinates
        const offset = new THREE.Vector3().subVectors(camera.position, target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        
        initialRotationRef.current = {
          x: spherical.phi,    // polar angle
          y: spherical.theta,  // azimuthal angle
          z: spherical.radius  // distance
        };
      } else if (sphereModeRef.current === 'pan') {
        // Store initial camera and target positions
        initialCameraPositionRef.current = {
          x: camera.position.x,
          y: camera.position.y,
          z: camera.position.z
        };
        initialRotationRef.current = {
          x: target.x,
          y: target.y,
          z: target.z
        };
      } else if (sphereModeRef.current === 'zoom') {
        // Store initial distance
        const offset = new THREE.Vector3().subVectors(camera.position, target);
        initialZoomRef.current = offset.length();
      }
    }
    
    // Capture pointer
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSpherePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDraggingSphere || !sphereDragStartRef.current || !controlsRef.current || !cameraRef.current) return;
    
    const deltaX = event.clientX - sphereDragStartRef.current.x;
    const deltaY = event.clientY - sphereDragStartRef.current.y;
    
    // Update current drag position for animation loop
    sphereDragCurrentRef.current = { x: event.clientX, y: event.clientY };
    
    if (sphereModeRef.current === 'rotate') {
      if (!initialRotationRef.current) return;
      
      // Rotate the camera around the target using spherical coordinates
      const rotationSpeed = 0.015;
      
      const newTheta = initialRotationRef.current.y - deltaX * rotationSpeed;
      const newPhi = THREE.MathUtils.clamp(
        initialRotationRef.current.x - deltaY * rotationSpeed,
        0.1,
        Math.PI - 0.1
      );
      const radius = initialRotationRef.current.z;
      
      // Convert spherical to cartesian and update camera position
      const offset = new THREE.Vector3();
      offset.x = radius * Math.sin(newPhi) * Math.sin(newTheta);
      offset.y = radius * Math.cos(newPhi);
      offset.z = radius * Math.sin(newPhi) * Math.cos(newTheta);
      
      const target = controlsRef.current.target;
      cameraRef.current.position.copy(target).add(offset);
      cameraRef.current.lookAt(target);
    } else if (sphereModeRef.current === 'pan') {
      if (!initialCameraPositionRef.current || !initialRotationRef.current) return;
      
      // Pan the camera
      const panSpeed = 0.03;
      
      // Get camera's local axes
      const camera = cameraRef.current;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      camera.matrix.extractBasis(right, up, new THREE.Vector3());
      
      // Calculate pan offset
      const panOffset = new THREE.Vector3();
      panOffset.addScaledVector(right, -deltaX * panSpeed);
      panOffset.addScaledVector(up, deltaY * panSpeed);
      
      // Update camera and target
      camera.position.set(
        initialCameraPositionRef.current.x + panOffset.x,
        initialCameraPositionRef.current.y + panOffset.y,
        initialCameraPositionRef.current.z + panOffset.z
      );
      controlsRef.current.target.set(
        initialRotationRef.current.x + panOffset.x,
        initialRotationRef.current.y + panOffset.y,
        initialRotationRef.current.z + panOffset.z
      );
    } else if (sphereModeRef.current === 'zoom') {
      if (!initialZoomRef.current) return;
      
      // Zoom in/out
      const zoomSpeed = 0.01;
      const zoomFactor = 1 + deltaY * zoomSpeed;
      const newDistance = initialZoomRef.current * zoomFactor;
      
      // Clamp zoom distance
      const clampedDistance = THREE.MathUtils.clamp(newDistance, 1, 1000);
      
      // Calculate new camera position
      const target = controlsRef.current.target;
      const direction = new THREE.Vector3().subVectors(cameraRef.current.position, target).normalize();
      cameraRef.current.position.copy(target).addScaledVector(direction, clampedDistance);
    }
  };

  const handleSpherePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation();
    setIsDraggingSphere(false);
    sphereDragStartRef.current = null;
    sphereDragCurrentRef.current = null;
    initialRotationRef.current = null;
    initialCameraPositionRef.current = null;
    initialZoomRef.current = null;
    
    // Release pointer capture
    event.currentTarget.releasePointerCapture(event.pointerId);

    // Advance tutorial for rotate/pan/zoom sphere actions
    if (sphereModeRef.current === 'rotate') {
      advanceTutorialRef.current('rotateView');
    } else if (sphereModeRef.current === 'pan') {
      advanceTutorialRef.current('panMode');
    } else if (sphereModeRef.current === 'zoom') {
      advanceTutorialRef.current('zoomMode');
    }
  };

  const tutorialAction = showTutorial && tutorialStep < tutorialSteps.length ? tutorialSteps[tutorialStep].action : null;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Reference Image - Top Right */}
      {referenceImageUrl && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            zIndex: 1001
          }}
        >
          {/* Toggle button */}
          <button
            onClick={() => setReferenceImageVisible(!referenceImageVisible)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              borderRadius: '8px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              padding: '8px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              color: '#374151',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.95)';
            }}
          >
            <span>Reference</span>
            <ChevronDown 
              size={12} 
              style={{ 
                transform: referenceImageVisible ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s'
              }} 
            />
          </button>
          
          {/* Image container */}
          {referenceImageVisible && (
            <div
              style={{
                marginTop: '4px',
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                borderRadius: '8px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                padding: '8px',
                maxWidth: window.innerWidth < 768 ? '100px' : '200px',
                transition: 'max-width 0.2s'
              }}
            >
              <img
                src={referenceImageUrl}
                alt="Reference"
                style={{
                  width: '100%',
                  height: 'auto',
                  borderRadius: '4px',
                  display: 'block'
                }}
              />
            </div>
          )}

          {/* Problematic voxels caution button - below reference image */}
          {problematicXyzrgbContent && problematicXyzrgbContent.trim().length > 0 && (
            <button
              onClick={() => setShowProblematicModal(true)}
              style={{
                position: 'relative',
                marginTop: '4px',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px',
                backgroundColor: 'rgba(239, 68, 68, 0.95)',
                color: 'white',
                borderRadius: '8px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                padding: '8px 10px',
                border: 'none',
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 600,
                transition: 'all 0.2s'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(220, 38, 38, 1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.95)';
              }}
              title="Some blocks have conflicts"
            >
              <AlertTriangle size={14} />
              <span>Block Conflicts</span>
              <span style={{
                position: 'absolute',
                bottom: '-4px',
                right: '-4px',
                width: '14px',
                height: '14px',
                borderRadius: '50%',
                backgroundColor: 'white',
                color: '#EF4444',
                fontSize: '9px',
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
              }}>?</span>
            </button>
          )}
        </div>
      )}

      {/* Problematic voxels caution icon - standalone when no reference image */}
      {!referenceImageUrl && problematicXyzrgbContent && problematicXyzrgbContent.trim().length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            zIndex: 1001
          }}
        >
          <button
            onClick={() => setShowProblematicModal(true)}
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: 'rgba(239, 68, 68, 0.95)',
              color: 'white',
              borderRadius: '8px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              padding: '8px 10px',
              border: 'none',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: 600,
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(220, 38, 38, 1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.95)';
            }}
            title="Some blocks have conflicts"
          >
            <AlertTriangle size={14} />
            <span>Block Conflicts</span>
            <span style={{
              position: 'absolute',
              bottom: '-4px',
              right: '-4px',
              width: '14px',
              height: '14px',
              borderRadius: '50%',
              backgroundColor: 'white',
              color: '#EF4444',
              fontSize: '9px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
            }}>?</span>
          </button>
        </div>
      )}

      {/* Problematic voxels modal */}
      {showProblematicModal && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)'
          }}
          onClick={() => setShowProblematicModal(false)}
        >
          <div
            style={{
              backgroundColor: 'white',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              padding: '24px',
              maxWidth: '420px',
              width: '90%',
              position: 'relative'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowProblematicModal(false)}
              style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#6B7280',
                padding: '4px'
              }}
            >
              <X size={18} />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderRadius: '50%',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <AlertTriangle size={22} color="#EF4444" />
              </div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#1F2937' }}>Block Conflicts Detected</h3>
            </div>
            {/* Illustration: isometric brick with red wireframe */}
            <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0 16px 0' }}>
              <svg width="120" height="100" viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                {/* Brick body - isometric box */}
                {/* Top face */}
                <polygon points="60,20 95,38 60,56 25,38" fill="#A0A0A0" />
                {/* Left face */}
                <polygon points="25,38 60,56 60,82 25,64" fill="#808080" />
                {/* Right face */}
                <polygon points="95,38 60,56 60,82 95,64" fill="#909090" />
                {/* Red wireframe outline */}
                <polygon points="60,14 100,34 60,54 20,34" fill="none" stroke="#EF4444" strokeWidth="2" />
                <polygon points="20,34 60,54 60,84 20,64" fill="none" stroke="#EF4444" strokeWidth="2" />
                <polygon points="100,34 60,54 60,84 100,64" fill="none" stroke="#EF4444" strokeWidth="2" />
                <line x1="60" y1="14" x2="60" y2="14" stroke="#EF4444" strokeWidth="2" />
                <line x1="20" y1="34" x2="20" y2="64" stroke="#EF4444" strokeWidth="2" />
                <line x1="100" y1="34" x2="100" y2="64" stroke="#EF4444" strokeWidth="2" />
                <line x1="60" y1="54" x2="60" y2="84" stroke="#EF4444" strokeWidth="2" />
                <line x1="60" y1="84" x2="20" y2="64" stroke="#EF4444" strokeWidth="0" />
                <line x1="60" y1="84" x2="100" y2="64" stroke="#EF4444" strokeWidth="0" />
                {/* Bottom face outline */}
                <polygon points="60,84 100,64 100,64 60,84" fill="none" stroke="#EF4444" strokeWidth="2" />
              </svg>
            </div>
            <p style={{ margin: '0 0 12px 0', fontSize: '14px', lineHeight: '1.6', color: '#4B5563' }}>
              Some blocks in your model have conflicts and are outlined in <span style={{ color: '#EF4444', fontWeight: 600 }}>red</span>, like the example above.
            </p>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: '1.6', color: '#4B5563' }}>
              During the brick conversion process, these blocks may have their colors merged with nearby blocks or be removed entirely. Please check your model outside of edit mode to see the final results after the conversion is complete.
            </p>
            <button
              onClick={() => setShowProblematicModal(false)}
              style={{
                width: '100%',
                padding: '10px',
                backgroundColor: '#6366F1',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#4F46E5'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#6366F1'; }}
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Resize warning modal */}
      {showResizeWarning && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.5)'
          }}
          onClick={() => setShowResizeWarning(false)}
        >
          <div
            style={{
              backgroundColor: 'white',
              borderRadius: '12px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
              padding: '24px',
              maxWidth: '420px',
              width: '90%',
              position: 'relative'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowResizeWarning(false)}
              style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: '#6B7280',
                padding: '4px'
              }}
            >
              <X size={18} />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                borderRadius: '50%',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <AlertTriangle size={22} color="#EF4444" />
              </div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#1F2937' }}>Resize Warning</h3>
            </div>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: '1.6', color: '#4B5563' }}>
              Resizing will remove your color and shape edits.
            </p>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: '1.6', color: '#4B5563' }}>
              You can always view your previous edits in the <Link to="/dashboard" style={{ color: '#8B5CF6', textDecoration: 'underline', fontWeight: 600 }}>dashboard</Link>.
            </p>
            <p style={{ margin: '0 0 16px 0', fontSize: '14px', lineHeight: '1.6', color: '#6B7280' }}>
              Do you want to continue?
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => setShowResizeWarning(false)}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: '#F3F4F6',
                  color: '#374151',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#E5E7EB'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#F3F4F6'; }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowResizeWarning(false);
                  if (onResize) {
                    onResize(resizeScaler ?? 25);
                  }
                  advanceTutorialRef.current('resize');
                }}
                style={{
                  flex: 1,
                  padding: '10px',
                  backgroundColor: '#EF4444',
                  color: 'white',
                  border: 'none',
                  borderRadius: '8px',
                  fontSize: '14px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'background-color 0.2s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#DC2626'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#EF4444'; }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* Mode buttons */}
      <div 
        style={{ 
          position: 'absolute', 
          top: '10px', 
          left: '10px', 
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px',
          ...(window.innerWidth < 768 ? { transform: 'scale(0.88)', transformOrigin: 'top left' } : {})
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: '4.8px',
            backgroundColor: 'rgba(255, 255, 255, 0.9)',
            padding: '4.8px',
            borderRadius: '9.6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
          }}
        >
        {/* Select button with dropdown */}
        <div style={{ position: 'relative', display: 'flex' }}>
          <button
            onClick={() => {
              trackMenuClick('select', { select_mode: selectSubMode });
              if (mode === 'select') {
                setSelectDropdownOpen(!selectDropdownOpen);
              } else {
                setMode('select');
                setSelectDropdownOpen(true);
              }
            }}
            title="Select Mode"
            className={tutorialAction === 'regularSelect' || tutorialAction === 'switchToByColor' || tutorialAction === 'byColorSelect' || tutorialAction === 'marqueeSelect' || tutorialAction === 'changeColor' || tutorialAction === 'delete' ? 'tutorial-pulse' : ''}
            style={{
              padding: '7.2px',
              borderTopLeftRadius: '7.2px',
              borderBottomLeftRadius: '7.2px',
              borderTopRightRadius: '0',
              borderBottomRightRadius: '0',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '2px',
              backgroundColor: mode === 'select' ? '#8B5CF6' : '#f3f4f6',
              color: mode === 'select' ? 'white' : '#374151',
              transition: 'all 0.2s'
            }}
          >
            {selectSubMode === 'byColor' ? (
              <Pipette size={21.6} />
            ) : selectSubMode === 'marquee' ? (
              <BoxSelect size={21.6} />
            ) : (
              <MousePointer2 size={21.6} />
            )}
          </button>
          
          {/* Dropdown toggle button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              trackMenuClick('select_dropdown');
              setSelectDropdownOpen(!selectDropdownOpen);
            }}
            className={tutorialAction === 'switchToByColor' || tutorialAction === 'byColorSelect' || tutorialAction === 'marqueeSelect' ? 'tutorial-pulse' : ''}
            style={{
              width: '22px',
              padding: '7.2px 4px',
              borderTopRightRadius: '7.2px',
              borderBottomRightRadius: '7.2px',
              borderTopLeftRadius: '0',
              borderBottomLeftRadius: '0',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: mode === 'select' ? '#7C3AED' : '#d1d5db',
              color: 'white',
              transition: 'all 0.2s'
            }}
          >
            <ChevronDown size={12} />
          </button>
          
          {/* Dropdown menu */}
          {selectDropdownOpen && (
            <>
              <div 
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 1000
                }}
                onClick={() => setSelectDropdownOpen(false)}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  marginTop: '4px',
                  backgroundColor: 'white',
                  borderRadius: '6px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  padding: '4px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                  zIndex: 1002,
                  minWidth: '140px'
                }}
              >
                <button
                  onClick={() => {
                    trackMenuClick('select_regular');
                    setSelectSubMode('regular');
                    setMode('select');
                    setSelectDropdownOpen(false);
                  }}
                  style={{
                    padding: '8px',
                    borderRadius: '4px',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    backgroundColor: selectSubMode === 'regular' ? '#EDE9FE' : 'transparent',
                    color: selectSubMode === 'regular' ? '#8B5CF6' : '#374151',
                    transition: 'all 0.2s',
                    textAlign: 'left',
                    fontSize: '13px'
                  }}
                  onMouseEnter={(e) => {
                    if (selectSubMode !== 'regular') {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectSubMode !== 'regular') {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <MousePointer2 size={16} />
                  <span>Regular</span>
                </button>
                <button
                  onClick={() => {
                    trackMenuClick('select_by_color');
                    setSelectSubMode('byColor');
                    setMode('select');
                    setSelectDropdownOpen(false);
                    advanceTutorialRef.current('switchToByColor');
                  }}
                  style={{
                    padding: '8px',
                    borderRadius: '4px',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    backgroundColor: selectSubMode === 'byColor' ? '#EDE9FE' : 'transparent',
                    color: selectSubMode === 'byColor' ? '#8B5CF6' : '#374151',
                    transition: 'all 0.2s',
                    textAlign: 'left',
                    fontSize: '13px'
                  }}
                  onMouseEnter={(e) => {
                    if (selectSubMode !== 'byColor') {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectSubMode !== 'byColor') {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <Pipette size={16} />
                  <span>By Color</span>
                </button>
                <button
                  onClick={() => {
                    trackMenuClick('select_marquee');
                    setSelectSubMode('marquee');
                    setMode('select');
                    setSelectDropdownOpen(false);
                  }}
                  style={{
                    padding: '8px',
                    borderRadius: '4px',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    backgroundColor: selectSubMode === 'marquee' ? '#EDE9FE' : 'transparent',
                    color: selectSubMode === 'marquee' ? '#8B5CF6' : '#374151',
                    transition: 'all 0.2s',
                    textAlign: 'left',
                    fontSize: '13px'
                  }}
                  onMouseEnter={(e) => {
                    if (selectSubMode !== 'marquee') {
                      e.currentTarget.style.backgroundColor = '#f3f4f6';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectSubMode !== 'marquee') {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <BoxSelect size={16} />
                  <span>Marquee</span>
                </button>
              </div>
            </>
          )}
        </div>
        
        {/* Pan button - commented out */}
        {/* <button
          onClick={() => setMode('pan')}
          title="Pan Mode - Two-finger drag to pan on mobile"
          style={{
            padding: '6px',
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: mode === 'pan' ? '#8B5CF6' : '#f3f4f6',
            color: mode === 'pan' ? 'white' : '#374151',
            transition: 'all 0.2s'
          }}
        >
          <Move size={18} />
        </button> */}
        <button
          onClick={() => {
            trackMenuClick('paint');
            setMode('paint');
            // Set paint color to selected color if available, otherwise use current or default
            if (selectedColor) {
              setPaintColor(selectedColor);
            } else if (!paintColor && colorPalette && colorPalette.length > 0) {
              setPaintColor(colorPalette[0]);
            }
          }}
          title="Paint Mode - Click and drag to paint blocks"
          className={tutorialAction === 'paint' ? 'tutorial-pulse' : ''}
          style={{
            padding: '7.2px',
            borderRadius: '7.2px',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: mode === 'paint' ? '#8B5CF6' : '#f3f4f6',
            color: mode === 'paint' ? 'white' : '#374151',
            transition: 'all 0.2s'
          }}
        >
          <Brush size={21.6} />
        </button>
        
        <button
          onClick={() => {
            trackMenuClick('add_block');
            setMode('add');
            // Set add color to selected color if available, otherwise use current or default
            if (selectedColor) {
              setAddColor(selectedColor);
            } else if (!addColor && colorPalette && colorPalette.length > 0) {
              setAddColor(colorPalette[0]);
            }
          }}
          title="Add Block Mode - Click on a face to add a block"
          className={tutorialAction === 'add' ? 'tutorial-pulse' : ''}
          style={{
            padding: '7.2px',
            borderRadius: '6px',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: mode === 'add' ? '#8B5CF6' : '#f3f4f6',
            color: mode === 'add' ? 'white' : '#374151',
            transition: 'all 0.2s',
            position: 'relative'
          }}
        >
          <Box size={21.6} />
          <Plus size={12} style={{ position: 'absolute', bottom: '2.4px', right: '2.4px' }} />
        </button>
        
        {/* Delete button - removes selected voxels */}
        <button
          onClick={() => {
            trackMenuClick('delete_blocks', { selection_count: selectionCount });
            deleteSelectedVoxels();
          }}
          disabled={selectionCount === 0}
          title={selectionCount > 0 ? `Delete ${selectionCount} selected voxel${selectionCount > 1 ? 's' : ''} (Delete/Backspace)` : 'No voxels selected'}
          className={tutorialAction === 'delete' && selectionCount > 0 ? 'tutorial-pulse' : ''}
          style={{
            padding: '7.2px',
            borderRadius: '7.2px',
            border: 'none',
            cursor: selectionCount > 0 ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: selectionCount > 0 ? '#EF4444' : '#f3f4f6',
            color: selectionCount > 0 ? 'white' : '#9ca3af',
            transition: 'all 0.2s',
            position: 'relative'
          }}
        >
          <Box size={21.6} />
          <Minus size={12} style={{ position: 'absolute', bottom: '2.4px', right: '2.4px' }} />
        </button>
        
        <div style={{ width: '1px', backgroundColor: '#d1d5db', margin: '4px 2px' }} />
        
        {/* Tutorial help button */}
        <button
          onClick={() => {
            trackMenuClick('tutorial');
            setShowTutorial(true);
            setTutorialStep(0);
          }}
          title="Show edit mode tutorial"
          style={{
            padding: '7.2px',
            borderRadius: '7.2px',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#f3f4f6',
            color: '#374151',
            transition: 'all 0.2s'
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#e5e7eb';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#f3f4f6';
          }}
        >
          <HelpCircle size={21.6} />
        </button>
        </div>
        
        <span style={{
          fontSize: '12px',
          color: '#6B7280',
          fontWeight: 500,
          textAlign: 'left',
          userSelect: 'none'
        }}>
          Select, paint, add, remove
        </span>
      </div>

      {/* Undo/Redo/Save Bar - Bottom left */}
      <div 
        style={{ 
          position: 'absolute', 
          bottom: '10px', 
          left: '10px', 
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
          gap: '4px'
        }}
      >
        <span style={{
          fontSize: '12px',
          color: '#D1D5DB',
          fontWeight: 500,
          textAlign: 'center',
          userSelect: 'none'
        }}>
          Undo, Redo, Save
        </span>
        <div
          style={{ 
            display: 'flex',
            gap: '4px',
            backgroundColor: 'rgba(255, 255, 255, 0.9)',
            padding: '4px',
            borderRadius: '8px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
          }}
        >
        {/* Undo button */}
        <button
          onClick={() => {
            trackMenuClick('undo');
            handleUndo();
          }}
          disabled={!canUndo}
          title={canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo'}
          className={tutorialAction === 'undo' ? 'tutorial-pulse' : ''}
          style={{
            padding: '6px',
            borderRadius: '6px',
            border: 'none',
            cursor: canUndo ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: canUndo ? '#6366F1' : '#f3f4f6',
            color: canUndo ? 'white' : '#9ca3af',
            transition: 'all 0.2s'
          }}
        >
          <Undo2 size={18} />
        </button>
        
        {/* Redo button */}
        <button
          onClick={() => {
            trackMenuClick('redo');
            handleRedo();
          }}
          disabled={!canRedo}
          title={canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo'}
          style={{
            padding: '6px',
            borderRadius: '6px',
            border: 'none',
            cursor: canRedo ? 'pointer' : 'not-allowed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: canRedo ? '#6366F1' : '#f3f4f6',
            color: canRedo ? 'white' : '#9ca3af',
            transition: 'all 0.2s'
          }}
        >
          <Redo2 size={18} />
        </button>
        
        {/* Save button - only show if generationId is provided */}
        {generationId && (
          <>
            <div style={{ width: '1px', backgroundColor: '#d1d5db', margin: '4px 2px' }} />
            <button
              onClick={() => {
                trackMenuClick('save');
                void handleSave();
              }}
              disabled={!hasChanges || isSaving}
              title={hasChanges ? 'Save Changes' : 'No changes to save'}
              className={tutorialAction === 'save' ? 'tutorial-pulse' : ''}
              style={{
                padding: '6px',
                borderRadius: '6px',
                border: 'none',
                cursor: hasChanges && !isSaving ? 'pointer' : 'not-allowed',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: hasChanges ? '#10B981' : '#f3f4f6',
                color: hasChanges ? 'white' : '#9ca3af',
                transition: 'all 0.2s',
                opacity: isSaving ? 0.7 : 1
              }}
            >
              <Save size={18} />
            </button>
          </>
        )}
        </div>
      </div>

      {/* Save error message */}
      {saveError && (
        <div
          style={{
            position: 'absolute',
            top: '90px',
            left: '10px',
            zIndex: 1001,
            backgroundColor: 'rgba(239, 68, 68, 0.9)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            maxWidth: '200px'
          }}
        >
          {saveError}
        </div>
      )}

      {/* Processing build banner */}
      {isProcessingSave && (
        <div
          style={{
            position: 'absolute',
            top: '90px',
            left: '10px',
            zIndex: 1001,
            backgroundColor: 'rgba(59, 130, 246, 0.9)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '6px',
            fontSize: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            maxWidth: '220px'
          }}
        >
          <div style={{
            width: '14px',
            height: '14px',
            border: '2px solid rgba(255,255,255,0.3)',
            borderTop: '2px solid white',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite'
          }} />
          Processing build...
        </div>
      )}

      {/* Bottom-right panel stack: Resize + Select Color */}
      <div
        style={{
          position: 'absolute',
          bottom: '10px',
          right: '10px',
          zIndex: 1001,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: '6px',
          width: window.innerWidth < 768 ? '85px' : '120px'
        }}
      >
        {/* Color Palette Panel */}
        {colorPalette && colorPalette.length > 0 && (
          <div
            ref={paletteRef}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              padding: '8px',
              borderRadius: '8px',
              boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
              overflow: 'hidden',
              width: paletteExpanded ? (window.innerWidth < 768 ? '72px' : '108px') : 'auto'
            }}
          >
          {/* Header with selected color */}
          <div 
            onClick={() => {
              trackMenuClick('color_palette_toggle', { expanded: !paletteExpanded });
              setPaletteExpanded(!paletteExpanded);
            }}
            style={{ 
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '6px',
              cursor: 'pointer',
              marginBottom: paletteExpanded ? '6px' : '0'
            }}
          >
            <div style={{ 
              fontSize: '11px', 
              fontWeight: 600,
              color: '#374151'
            }}>
              Select Color
            </div>
            {selectedColor && !paletteExpanded && (
              <div
                style={{ 
                  width: '24px', 
                  height: '24px', 
                  backgroundColor: `rgb(${selectedColor.r}, ${selectedColor.g}, ${selectedColor.b})`,
                  borderRadius: '4px',
                  border: '2px solid #8B5CF6',
                  flexShrink: 0
                }}
                title={`${selectedColor.name}. Click to ${paletteExpanded ? 'hide' : 'show'} palette`}
              />
            )}
          </div>
          
          {/* Expanded color grid */}
          {paletteExpanded && (
            <div style={{ 
              display: 'grid',
              gridTemplateColumns: window.innerWidth < 768 ? 'repeat(3, 18px)' : 'repeat(3, 28px)',
              gap: '4px'
            }}>
              {colorPalette.map((color) => (
                <button
                  key={color.name}
                  onClick={() => {
                    trackMenuClick('color_selected', { color_name: color.name });
                    setSelectedColor(color);
                    if (mode === 'add') {
                      setAddColor(color);
                    } else if (mode === 'paint') {
                      setPaintColor(color);
                    } else {
                      applyColorToSelection(color);
                    }
                  }}
                  title={color.name}
                  style={{
                    width: window.innerWidth < 768 ? '18px' : '28px',
                    height: window.innerWidth < 768 ? '18px' : '28px',
                    backgroundColor: `#${color.hex}`,
                    border: selectedColor?.hex === color.hex ? '3px solid #8B5CF6' : '1px solid rgba(0,0,0,0.2)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'transform 0.1s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                  onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                />
              ))}
            </div>
          )}
          </div>
        )}

        {/* Resize Model Panel */}
        {showResizeScaler && onResize && (
          <div
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.95)',
              padding: '8px',
              borderRadius: '8px',
              boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
              overflow: 'hidden'
            }}
          >
            {/* Header row - click to toggle */}
            <div
              onClick={() => {
                trackMenuClick('resize_panel_toggle', { expanded: !resizeExpanded });
                setResizeExpanded(!resizeExpanded);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
                marginBottom: resizeExpanded ? '6px' : '0'
              }}
            >
              <div style={{ fontSize: '11px', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' }}>
                Resize Model
              </div>

            </div>

            {/* Expanded: slider + button */}
            {resizeExpanded && (
              <div>
                <input
                  aria-label="Model scaler"
                  type="range"
                  min={10}
                  max={60}
                  step={1}
                  value={resizeScaler ?? 25}
                  onChange={(e) => onResizeScalerChange?.(parseInt(e.target.value, 10))}
                  disabled={isResizing}
                  style={{ width: '100%', height: '4px', cursor: isResizing ? 'not-allowed' : 'pointer' }}
                />
                <div style={{ fontSize: '10px', color: '#6B7280', textAlign: 'center', margin: '2px 0 6px' }}>
                  {resizeScaler ?? 25}
                </div>
                <button
                  onClick={() => {
                    if (!isResizing) {
                      trackMenuClick('resize', { detail_level: resizeScaler ?? 25 });
                      setShowResizeWarning(true);
                    }
                  }}
                  disabled={isResizing}
                  className={tutorialAction === 'resize' ? 'tutorial-pulse' : ''}
                  style={{
                    width: '100%',
                    padding: '4px 0',
                    border: 'none',
                    borderRadius: '4px',
                    backgroundColor: isResizing ? '#9CA3AF' : '#EF4444',
                    color: 'white',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: isResizing ? 'not-allowed' : 'pointer',
                    transition: 'background-color 0.2s'
                  }}
                  onMouseEnter={(e) => { if (!isResizing) e.currentTarget.style.backgroundColor = '#DC2626'; }}
                  onMouseLeave={(e) => { if (!isResizing) e.currentTarget.style.backgroundColor = '#EF4444'; }}
                >
                  {isResizing ? 'Resizing...' : 'Resize'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sphere Rotator Tool - Bottom Center */}
      <div style={{
        position: 'absolute',
        bottom: '10px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1002,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '4px'
      }}>
        {/* Sphere and chevron controls */}
        <div style={{
          display: 'flex',
          gap: '8px',
          alignItems: window.innerWidth < 768 ? 'flex-start' : 'center'
        }}>
          <button
            onClick={() => {
              trackMenuClick('previous_camera_mode', { current_mode: sphereMode });
              setSphereMode(prev => 
                prev === 'rotate' ? 'zoom' : prev === 'pan' ? 'rotate' : 'pan'
              );
            }}
            className={tutorialAction === 'panMode' || tutorialAction === 'zoomMode' ? 'tutorial-pulse' : ''}
            style={{
              padding: '7.2px',
              borderRadius: '7.2px',
              border: 'none',
              backgroundColor: 'rgba(255, 255, 255, 0.9)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 1)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.9)'}
            title="Previous mode"
          >
            <ChevronLeft size={20} color="#8B5CF6" />
          </button>
          
          <canvas
            ref={sphereCanvasRef}
            width={80}
            height={80}
            onPointerDown={handleSpherePointerDown}
            onPointerMove={handleSpherePointerMove}
            onPointerUp={handleSpherePointerUp}
            className={tutorialAction === 'rotateView' || tutorialAction === 'panMode' || tutorialAction === 'zoomMode' ? 'tutorial-pulse' : ''}
            style={{
              cursor: isDraggingSphere ? 'grabbing' : 'grab',
              borderRadius: '50%',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              touchAction: 'none'
            }}
            title={`Click and drag to ${sphereMode} model`}
          />
          
          <button
            onClick={() => {
              trackMenuClick('next_camera_mode', { current_mode: sphereMode });
              setSphereMode(prev => 
                prev === 'rotate' ? 'pan' : prev === 'pan' ? 'zoom' : 'rotate'
              );
            }}
            className={tutorialAction === 'panMode' || tutorialAction === 'zoomMode' ? 'tutorial-pulse' : ''}
            style={{
              padding: '7.2px',
              borderRadius: '7.2px',
              border: 'none',
              backgroundColor: 'rgba(255, 255, 255, 0.9)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'background-color 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 1)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.9)'}
            title="Next mode"
          >
            <ChevronRight size={20} color="#8B5CF6" />
          </button>
        </div>
        
        <span style={{
          fontSize: '12px',
          color: '#D1D5DB',
          fontWeight: 500,
          textAlign: 'center',
          userSelect: 'none'
        }}>
          {sphereMode === 'rotate' ? 'Rotate Object' : sphereMode === 'pan' ? 'Pan object' : 'Zoom in/out'}
        </span>
      </div>

      <div 
        ref={containerRef} 
        className={`w-full h-full ${className}`}
        style={{ minHeight: '400px', cursor: getCursor(), position: 'relative' }}
      >
        {isSelecting && selectionStart && selectionEnd && mode === 'select' && selectSubMode === 'marquee' && (
          <div style={getMarqueeStyle()} />
        )}
      </div>

      {/* Interactive Tutorial Banner */}
      {showTutorial && tutorialStep < tutorialSteps.length && (
        <>
          {/* Welcome/Done overlay - only for start and done steps */}
          {(tutorialSteps[tutorialStep].action === 'start' || tutorialSteps[tutorialStep].action === 'done') && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 2000,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: 'rgba(0, 0, 0, 0.5)',
                backdropFilter: 'blur(2px)'
              }}
            >
              <div
                style={{
                  backgroundColor: 'white',
                  borderRadius: '16px',
                  padding: '28px',
                  maxWidth: '420px',
                  width: '90%',
                  boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                  textAlign: 'center'
                }}
              >
                <h3 style={{
                  fontSize: '20px',
                  fontWeight: 700,
                  color: '#111827',
                  marginBottom: '12px',
                  marginTop: 0
                }}>
                  {tutorialSteps[tutorialStep].title}
                </h3>
                <p style={{
                  fontSize: '14px',
                  lineHeight: '1.6',
                  color: '#4B5563',
                  marginBottom: '20px',
                  marginTop: 0
                }}>
                  {tutorialSteps[tutorialStep].instruction}
                </p>
                <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
                  <button
                    onClick={closeTutorial}
                    style={{
                      padding: '8px 20px',
                      borderRadius: '8px',
                      border: '1px solid #d1d5db',
                      backgroundColor: 'white',
                      color: '#374151',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: 500,
                      transition: 'all 0.2s'
                    }}
                  >
                    {tutorialSteps[tutorialStep].action === 'done' ? 'Close' : 'Skip Tutorial'}
                  </button>
                  {tutorialSteps[tutorialStep].action === 'start' && (
                    <button
                      onClick={() => advanceTutorialRef.current('start')}
                      style={{
                        padding: '8px 24px',
                        borderRadius: '8px',
                        border: 'none',
                        backgroundColor: '#8B5CF6',
                        color: 'white',
                        cursor: 'pointer',
                        fontSize: '14px',
                        fontWeight: 600,
                        transition: 'all 0.2s'
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#7C3AED'}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#8B5CF6'}
                    >
                      Start
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Floating instruction banner for action steps */}
          {tutorialSteps[tutorialStep].action !== 'start' && tutorialSteps[tutorialStep].action !== 'done' && (() => {
            const action = tutorialSteps[tutorialStep].action;
            const isSmall = window.innerWidth < 768;

            // Position config based on action and screen size
            let posStyle: React.CSSProperties;
            if (isSmall) {
              // Small screens: always bottom-left above sphere area
              posStyle = { bottom: '120px', left: '10px' };
            } else if (action === 'rotateView' || action === 'panMode' || action === 'zoomMode') {
              // Above the sphere rotator (bottom center)
              posStyle = { bottom: '140px', left: '50%', transform: 'translateX(-50%)' };
            } else if (action === 'undo' || action === 'save') {
              // Above the undo/redo/save bar (bottom left)
              posStyle = { bottom: '80px', left: '10px' };
            } else if (action === 'changeColor' || action === 'resize') {
              // To the left of the bottom-right panel
              posStyle = { bottom: '10px', right: '140px' };
            } else if (action === 'switchToByColor' || action === 'marqueeSelect') {
              // Push lower so the open select dropdown isn't covered by the instruction box
              posStyle = { top: '210px', left: '10px' };
            } else {
              // Below the top-left toolbar (select, paint, add, delete, byColorSelect, marqueeSelect)
              posStyle = { top: '90px', left: '10px' };
            }

            return (
            <div
              style={{
                position: 'absolute',
                zIndex: 2000,
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
                backgroundColor: 'rgba(255, 255, 255, 0.95)',
                padding: '10px 12px',
                borderRadius: '12px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
                maxWidth: '260px',
                width: 'fit-content',
                ...posStyle
              }}
            >
              {/* Top row: badge + text */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                {/* Step badge */}
                <div style={{
                  backgroundColor: '#8B5CF6',
                  color: 'white',
                  borderRadius: '50%',
                  width: '24px',
                  height: '24px',
                  minWidth: '24px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: 700,
                  flexShrink: 0
                }}>
                  {tutorialStep}
                </div>

                {/* Text */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '12px',
                    fontWeight: 700,
                    color: '#111827',
                    marginBottom: '2px',
                    lineHeight: '1.3'
                  }}>
                    {tutorialSteps[tutorialStep].title}
                  </div>
                  <div style={{
                    fontSize: '11px',
                    color: '#4B5563',
                    lineHeight: '1.4'
                  }}>
                    {tutorialSteps[tutorialStep].instruction}
                  </div>
                </div>
              </div>

              {/* Bottom row: nav + progress + close */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '4px',
                borderTop: '1px solid #e5e7eb',
                paddingTop: '6px'
              }}>
                {/* Back button */}
                <button
                  onClick={() => {
                    if (tutorialStep > 1) {
                      setTutorialStep(tutorialStep - 1);
                    }
                  }}
                  disabled={tutorialStep <= 1}
                  title="Previous step"
                  style={{
                    padding: '2px',
                    border: 'none',
                    backgroundColor: 'transparent',
                    cursor: tutorialStep <= 1 ? 'not-allowed' : 'pointer',
                    color: tutorialStep <= 1 ? '#d1d5db' : '#8B5CF6',
                    borderRadius: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s',
                    flexShrink: 0
                  }}
                >
                  <ChevronLeft size={16} />
                </button>

                {/* Progress */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                  flex: 1,
                  justifyContent: 'center'
                }}>
                  <span style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 500, whiteSpace: 'nowrap' }}>
                    {tutorialStep}/{tutorialSteps.length - 2}
                  </span>
                </div>

                {/* Forward button */}
                <button
                onClick={() => {
                  const nextStep = tutorialStep + 1;
                  if (nextStep < tutorialSteps.length) {
                    setTutorialStep(nextStep);
                    const nextAction = tutorialSteps[nextStep].action;
                    if (nextAction === 'rotateView') {
                      setSphereMode('rotate');
                    } else if (nextAction === 'panMode') {
                      setSphereMode('pan');
                    } else if (nextAction === 'zoomMode') {
                      setSphereMode('zoom');
                    } else if (nextAction === 'regularSelect') {
                      setMode('select');
                      setSelectSubMode('regular');
                    } else if (nextAction === 'switchToByColor') {
                      setMode('select');
                      setSelectSubMode('regular');
                    } else if (nextAction === 'byColorSelect') {
                      setMode('select');
                      setSelectSubMode('byColor');
                    } else if (nextAction === 'marqueeSelect') {
                      setMode('select');
                      setSelectSubMode('marquee');
                    } else if (nextAction === 'changeColor') {
                      setMode('select');
                      setSelectSubMode('regular');
                    } else if (nextAction === 'delete') {
                      setMode('select');
                      setSelectSubMode('regular');
                    } else if (nextAction === 'paint') {
                      setMode('paint');
                    } else if (nextAction === 'add') {
                      setMode('add');
                    } else if (nextAction === 'resize' && !showResizeScaler) {
                      setTutorialStep(nextStep + 1);
                    }
                  }
                }}
                disabled={tutorialStep >= tutorialSteps.length - 1}
                title="Next step"
                style={{
                  padding: '2px',
                  border: 'none',
                  backgroundColor: 'transparent',
                  cursor: tutorialStep >= tutorialSteps.length - 1 ? 'not-allowed' : 'pointer',
                  color: tutorialStep >= tutorialSteps.length - 1 ? '#d1d5db' : '#8B5CF6',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s',
                  flexShrink: 0
                }}
              >
                <ChevronRight size={16} />
              </button>

              {/* Skip button */}
              <button
                onClick={closeTutorial}
                title="Skip tutorial"
                style={{
                  padding: '2px',
                  border: 'none',
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                  color: '#9ca3af',
                  borderRadius: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s',
                  flexShrink: 0
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f3f4f6';
                  e.currentTarget.style.color = '#374151';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                  e.currentTarget.style.color = '#9ca3af';
                }}
              >
                <X size={14} />
              </button>
              </div>
            </div>
          );})()}
        </>
      )}
    </div>
  );
}
