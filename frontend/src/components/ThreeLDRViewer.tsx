import React, { useEffect, useRef, useState } from 'react';
import * as RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
import { RotateCcw, Ruler } from 'lucide-react';
import { captureTransparentPreview } from '../utils/captureTransparentPreview';

// Build a simple stylized room with a table, sized to fit the model.
const buildRoom = (
  scene: THREE.Scene,
  bbox: THREE.Box3,
  center: THREE.Vector3,
  size: THREE.Vector3,
  maxDim: number,
  hasBaseplate: boolean
) => {
  const existing = scene.getObjectByName('display-room');
  if (existing) scene.remove(existing);

  const room = new THREE.Group();
  room.name = 'display-room';

  // ── Materials ──
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xc8b99a, roughness: 0.85, metalness: 0.0 }); // warm wood
  const wallMat  = new THREE.MeshStandardMaterial({ color: 0xf0ebe1, roughness: 0.95, metalness: 0.0 }); // off-white plaster
  const tableMat = new THREE.MeshStandardMaterial({ color: 0x8B5E3C, roughness: 0.7, metalness: 0.05 }); // darker wood
  const legMat   = new THREE.MeshStandardMaterial({ color: 0x6B4226, roughness: 0.75, metalness: 0.05 });

  // ── Dimensions (relative to model) ──
  const roomW = maxDim * 6;   // width  (X)
  const roomH = maxDim * 4;   // height (Y)
  const roomD = maxDim * 6;   // depth  (Z)

  // If there's a baseplate, the table surface must sit below it.
  // Baseplate base mesh: height 4, centered at bbox.min.y - 2, so bottom at bbox.min.y - 4
  const baseplateBottomOffset = hasBaseplate ? 4 : 0;

  const tableThick = maxDim * 0.05;
  // Table top-surface aligns with model base (or below baseplate bottom)
  const tableTopSurface = bbox.min.y - baseplateBottomOffset;
  const tableTopY = tableTopSurface - tableThick / 2; // center of box

  const floorY = tableTopY - tableThick / 2 - maxDim * 0.6; // floor sits below the table

  // ── Floor ──
  const floorGeo = new THREE.PlaneGeometry(roomW, roomD);
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(center.x, floorY, center.z);
  floor.receiveShadow = true;
  room.add(floor);

  // ── Back wall ──
  const backWallGeo = new THREE.PlaneGeometry(roomW, roomH);
  const backWall = new THREE.Mesh(backWallGeo, wallMat);
  backWall.position.set(center.x, floorY + roomH / 2, center.z - roomD / 2);
  backWall.receiveShadow = true;
  room.add(backWall);

  // ── Left wall ──
  const sideWallGeo = new THREE.PlaneGeometry(roomD, roomH);
  const leftWall = new THREE.Mesh(sideWallGeo, wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(center.x - roomW / 2, floorY + roomH / 2, center.z);
  leftWall.receiveShadow = true;
  room.add(leftWall);

  // ── Table (in its own group so it can be hidden independently) ──
  const tableGroup = new THREE.Group();
  tableGroup.name = 'display-table';

  const tableW = roomW;
  const tableD = roomD;
  tableGroup.userData.hideBelowY = tableTopSurface;
  tableGroup.userData.tableTopSurface = tableTopSurface;
  tableGroup.userData.tableThickness = tableThick;
  tableGroup.userData.tableWidth = tableW;
  tableGroup.userData.tableDepth = tableD;
  tableGroup.userData.tableCenterX = center.x;
  tableGroup.userData.tableCenterZ = center.z;
  tableGroup.userData.floorY = floorY;
  tableGroup.userData.roomWidth = roomW;
  tableGroup.userData.roomDepth = roomD;

  // Tabletop
  const topGeo = new THREE.BoxGeometry(tableW, tableThick, tableD);
  const tabletop = new THREE.Mesh(topGeo, tableMat);
  tabletop.position.set(center.x, tableTopY, center.z);
  tabletop.castShadow = true;
  tabletop.receiveShadow = true;
  tableGroup.add(tabletop);

  // Table legs
  const legH = tableTopY - tableThick / 2 - floorY;
  const legR = maxDim * 0.025;
  const legGeo = new THREE.CylinderGeometry(legR, legR, legH, 8);
  const legPositions = [
    [center.x - tableW / 2 + legR * 3, floorY + legH / 2, center.z - tableD / 2 + legR * 3],
    [center.x + tableW / 2 - legR * 3, floorY + legH / 2, center.z - tableD / 2 + legR * 3],
    [center.x - tableW / 2 + legR * 3, floorY + legH / 2, center.z + tableD / 2 - legR * 3],
    [center.x + tableW / 2 - legR * 3, floorY + legH / 2, center.z + tableD / 2 - legR * 3],
  ];
  for (const [lx, ly, lz] of legPositions) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(lx, ly, lz);
    leg.castShadow = true;
    tableGroup.add(leg);
  }

  room.add(tableGroup);

  scene.add(room);
};

const LDRAW_UNIT_TO_MM = 0.4;

const formatLDrawMeasurement = (lengthLdu: number) => {
  const millimeters = Math.abs(lengthLdu) * LDRAW_UNIT_TO_MM;
  const inches = millimeters / 25.4;
  const centimeters = millimeters / 10;
  const inchPrecision = inches < 10 ? 2 : 1;
  const cmPrecision = centimeters < 10 ? 1 : 0;

  return `${inches.toFixed(inchPrecision)} in (${centimeters.toFixed(cmPrecision)} cm)`;
};

const RULER_LABEL_PIXEL_HEIGHT = 34;

const createRulerLabel = (text: string) => {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const canvasWidth = 640;
  const canvasHeight = 128;
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  if (!context) return null;

  context.clearRect(0, 0, canvasWidth, canvasHeight);
  context.fillStyle = 'rgba(255, 255, 255, 0.88)';
  context.strokeStyle = 'rgba(15, 23, 42, 0.18)';
  context.lineWidth = 8;
  context.roundRect(8, 18, canvasWidth - 16, canvasHeight - 36, 22);
  context.fill();
  context.stroke();
  context.font = '600 38px Arial, sans-serif';
  context.fillStyle = '#000000';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvasWidth / 2, canvasHeight / 2 + 2, canvasWidth - 48);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    depthTest: false,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.userData.rulerLabelAspect = canvasWidth / canvasHeight;
  sprite.userData.rulerLabelPixelHeight = RULER_LABEL_PIXEL_HEIGHT;
  sprite.scale.set(canvasWidth / canvasHeight, 1, 1);
  sprite.renderOrder = 20;

  return sprite;
};

const updateRulerLabelScales = (
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
) => {
  const rulerGrid = scene.getObjectByName('ruler-grid');
  if (!rulerGrid?.visible) return;

  const renderSize = renderer.getSize(new THREE.Vector2());
  const viewportHeight = Math.max(renderSize.y, 1);
  const fovRadians = THREE.MathUtils.degToRad(camera.fov);

  rulerGrid.traverse((object) => {
    if (!(object instanceof THREE.Sprite)) return;

    const pixelHeight = typeof object.userData.rulerLabelPixelHeight === 'number'
      ? object.userData.rulerLabelPixelHeight
      : RULER_LABEL_PIXEL_HEIGHT;
    const aspect = typeof object.userData.rulerLabelAspect === 'number'
      ? object.userData.rulerLabelAspect
      : 1;
    const distance = camera.position.distanceTo(object.getWorldPosition(new THREE.Vector3()));
    const visibleHeight = 2 * Math.tan(fovRadians / 2) * distance;
    const worldHeight = (pixelHeight / viewportHeight) * visibleHeight;

    object.scale.set(worldHeight * aspect, worldHeight, 1);
  });
};

const createLine = (
  start: THREE.Vector3,
  end: THREE.Vector3,
  color: number,
  opacity = 1,
) => {
  const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
  const material = new THREE.LineBasicMaterial({
    color,
    transparent: opacity < 1,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 10;
  return line;
};

const getGridSpacing = (maxDimension: number) => {
  const targetSpacing = maxDimension / 10;
  const candidates = [10, 20, 40, 80, 160, 320, 640];
  return candidates.find((candidate) => candidate >= targetSpacing) ?? candidates[candidates.length - 1];
};

const buildRulerGrid = (
  scene: THREE.Scene,
  bbox: THREE.Box3,
  maxDimension: number,
) => {
  const existing = scene.getObjectByName('ruler-grid');
  if (existing) scene.remove(existing);

  const group = new THREE.Group();
  group.name = 'ruler-grid';

  const gridY = bbox.min.y + Math.max(maxDimension * 0.01, 2);
  const axisOffset = Math.max(maxDimension * 0.08, 18);
  const labelOffset = Math.max(maxDimension * 0.12, 28);
  const tickSize = Math.max(maxDimension * 0.025, 8);
  const xAxisZ = bbox.min.z - axisOffset;
  const zAxisX = bbox.min.x - axisOffset;

  const gridSpacing = getGridSpacing(maxDimension);
  const gridMaterialColor = 0x64748b;
  for (let x = Math.ceil(bbox.min.x / gridSpacing) * gridSpacing; x <= bbox.max.x; x += gridSpacing) {
    group.add(createLine(
      new THREE.Vector3(x, gridY, bbox.min.z),
      new THREE.Vector3(x, gridY, bbox.max.z),
      gridMaterialColor,
      0.22,
    ));
  }

  for (let z = Math.ceil(bbox.min.z / gridSpacing) * gridSpacing; z <= bbox.max.z; z += gridSpacing) {
    group.add(createLine(
      new THREE.Vector3(bbox.min.x, gridY, z),
      new THREE.Vector3(bbox.max.x, gridY, z),
      gridMaterialColor,
      0.22,
    ));
  }

  group.add(createLine(
    new THREE.Vector3(bbox.min.x, gridY, xAxisZ),
    new THREE.Vector3(bbox.max.x, gridY, xAxisZ),
    0xef4444,
  ));
  group.add(createLine(
    new THREE.Vector3(bbox.min.x, gridY - tickSize / 2, xAxisZ),
    new THREE.Vector3(bbox.min.x, gridY + tickSize / 2, xAxisZ),
    0xef4444,
  ));
  group.add(createLine(
    new THREE.Vector3(bbox.max.x, gridY - tickSize / 2, xAxisZ),
    new THREE.Vector3(bbox.max.x, gridY + tickSize / 2, xAxisZ),
    0xef4444,
  ));

  group.add(createLine(
    new THREE.Vector3(zAxisX, gridY, bbox.min.z),
    new THREE.Vector3(zAxisX, gridY, bbox.max.z),
    0x2563eb,
  ));
  group.add(createLine(
    new THREE.Vector3(zAxisX - tickSize / 2, gridY, bbox.min.z),
    new THREE.Vector3(zAxisX + tickSize / 2, gridY, bbox.min.z),
    0x2563eb,
  ));
  group.add(createLine(
    new THREE.Vector3(zAxisX - tickSize / 2, gridY, bbox.max.z),
    new THREE.Vector3(zAxisX + tickSize / 2, gridY, bbox.max.z),
    0x2563eb,
  ));

  group.add(createLine(
    new THREE.Vector3(zAxisX, bbox.min.y, xAxisZ),
    new THREE.Vector3(zAxisX, bbox.max.y, xAxisZ),
    0x16a34a,
  ));
  group.add(createLine(
    new THREE.Vector3(zAxisX - tickSize / 2, bbox.min.y, xAxisZ),
    new THREE.Vector3(zAxisX + tickSize / 2, bbox.min.y, xAxisZ),
    0x16a34a,
  ));
  group.add(createLine(
    new THREE.Vector3(zAxisX - tickSize / 2, bbox.max.y, xAxisZ),
    new THREE.Vector3(zAxisX + tickSize / 2, bbox.max.y, xAxisZ),
    0x16a34a,
  ));

  const xLabel = createRulerLabel(formatLDrawMeasurement(bbox.max.x - bbox.min.x));
  if (xLabel) {
    xLabel.position.set(bbox.max.x + labelOffset, gridY, xAxisZ);
    group.add(xLabel);
  }

  const zLabel = createRulerLabel(formatLDrawMeasurement(bbox.max.z - bbox.min.z));
  if (zLabel) {
    zLabel.position.set(zAxisX, gridY, bbox.max.z + labelOffset);
    group.add(zLabel);
  }

  const yLabel = createRulerLabel(formatLDrawMeasurement(bbox.max.y - bbox.min.y));
  if (yLabel) {
    yLabel.position.set(zAxisX, bbox.max.y + labelOffset * 0.5, xAxisZ);
    group.add(yLabel);
  }

  scene.add(group);
};

// Capture a clean preview of just the model on a transparent background.
// Hides the display room (floor, walls, table) and the baseplate, renders one
// frame from a flattering front-left angle, then restores all original state.
export const captureCleanPreview = (
  camera: THREE.PerspectiveCamera,
  controls: any,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): string | null => {
  const model = scene.getObjectByName('ldraw-model');
  if (!model) return null;

  // Save state we are about to mutate.
  const originalPosition = camera.position.clone();
  const originalTarget = controls.target.clone();
  const originalBackground = scene.background;
  const room = scene.getObjectByName('display-room');
  const baseplate = scene.getObjectByName('baseplate');
  const rulerGrid = scene.getObjectByName('ruler-grid');
  const roomWasVisible = room ? room.visible : false;
  const baseplateWasVisible = baseplate ? baseplate.visible : false;
  const rulerGridWasVisible = rulerGrid ? rulerGrid.visible : false;

  // Renderer size + camera aspect are temporarily changed so the captured
  // image is a tight square around the model rather than the wide aspect of
  // the viewer canvas.
  const originalSize = new THREE.Vector2();
  renderer.getSize(originalSize);
  const originalAspect = camera.aspect;

  try {
    // Hide environment so only the model is visible.
    if (room) room.visible = false;
    if (baseplate) baseplate.visible = false;
    if (rulerGrid) rulerGrid.visible = false;

    // Render to a square so the result isn't mostly empty horizontal space.
    // updateStyle=false leaves the on-screen canvas CSS size untouched.
    const previewSize = 1024;
    renderer.setSize(previewSize, previewSize, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();

    // Frame the model from a flattering front-left angle, then rotate the
    // camera 15° around +Y so the model appears rotated 15° clockwise in the
    // captured image.
    const bbox = new THREE.Box3().setFromObject(model);
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const distance = maxDimension * 1.8;

    const offset = new THREE.Vector3(-1, 0.5, 1)
      .normalize()
      .multiplyScalar(distance)
      .applyAxisAngle(
        new THREE.Vector3(0, 1, 0),
        THREE.MathUtils.degToRad(15),
      );

    camera.position.copy(center).add(offset);
    controls.target.copy(center);
    controls.update();

    return captureTransparentPreview(renderer, scene, camera);
  } catch (err) {
    console.warn('Failed to capture clean preview:', err);
    return null;
  } finally {
    // Restore everything so the user-facing view is unchanged.
    scene.background = originalBackground;
    if (room) room.visible = roomWasVisible;
    if (baseplate) baseplate.visible = baseplateWasVisible;
    if (rulerGrid) rulerGrid.visible = rulerGridWasVisible;
    renderer.setSize(originalSize.x, originalSize.y, false);
    camera.aspect = originalAspect;
    camera.updateProjectionMatrix();
    camera.position.copy(originalPosition);
    controls.target.copy(originalTarget);
    controls.update();
    renderer.render(scene, camera);
  }
};

// Function to capture screenshots from different angles
const captureScreenshots = (
  camera: THREE.PerspectiveCamera, 
  controls: any, 
  renderer: THREE.WebGLRenderer, 
  scene: THREE.Scene,
  callback: (screenshots: { angle1: string; angle2: string }) => void
) => {
  const originalPosition = camera.position.clone();
  const originalTarget = controls.target.clone();
  
  // Calculate model center and distance
  const bbox = new THREE.Box3().setFromObject(scene.getObjectByName('ldraw-model')!);
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  const distance = maxDimension * 1.8;
  
  // Angle 1: Front-left view
  camera.position.copy(center).add(new THREE.Vector3(-1, 0.5, 1).normalize().multiplyScalar(distance));
  controls.target.copy(center);
  controls.update();
  renderer.render(scene, camera);
  const angle1 = renderer.domElement.toDataURL('image/png');
  
  // Angle 2: Front-right view  
  camera.position.copy(center).add(new THREE.Vector3(1, 0.5, 1).normalize().multiplyScalar(distance));
  controls.target.copy(center);
  controls.update();
  renderer.render(scene, camera);
  const angle2 = renderer.domElement.toDataURL('image/png');
  
  // Restore original camera position
  camera.position.copy(originalPosition);
  controls.target.copy(originalTarget);
  controls.update();
  
  callback({ angle1, angle2 });
};

// Function to add outline effect to new parts
const addOutlineToNewParts = async (mainModel: THREE.Group, newPartsContent: string, scene: THREE.Scene) => {
  try {
    const loader = new LDrawLoader();
    loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
    loader.smoothNormals = false;

    // Create blob URL for new parts content
    const blob = new Blob([newPartsContent], { type: 'text/plain' });
    const objectUrl = URL.createObjectURL(blob);

    // Load the new parts model to identify which parts to highlight
    loader.load(
      objectUrl,
      (newPartsModel: THREE.Group) => {
        // Create outline material - bright blue for high visibility
        const outlineMaterial = new THREE.MeshBasicMaterial({
          color: 0x0080ff, // Bright blue outline for maximum visibility
          side: THREE.BackSide,
          transparent: false,
        });

        // Collect all meshes from the new parts model with their world positions
        const newPartsMeshes: Array<{mesh: THREE.Mesh, worldPosition: THREE.Vector3}> = [];
        
        newPartsModel.rotation.x = Math.PI; // Match main model rotation
        newPartsModel.updateMatrixWorld(true);
        
        newPartsModel.traverse((obj) => {
          if (obj.type === 'Mesh') {
            const mesh = obj as THREE.Mesh;
            const worldPosition = new THREE.Vector3();
            mesh.getWorldPosition(worldPosition);
            newPartsMeshes.push({ mesh, worldPosition });
          }
        });

        // Find matching meshes in main model and add outlines
        mainModel.traverse((obj) => {
          if (obj.type === 'Mesh') {
            const mainMesh = obj as THREE.Mesh;
            const mainWorldPosition = new THREE.Vector3();
            mainMesh.getWorldPosition(mainWorldPosition);
            
            // Check if this mesh corresponds to a new part (by comparing positions)
            const matchingNewPart = newPartsMeshes.find(newPart => 
              newPart.worldPosition.distanceTo(mainWorldPosition) < 5 // Small tolerance for position matching
            );
            
            if (matchingNewPart) {
              // Create outline for this mesh
              try {
                const outlineGeometry = mainMesh.geometry.clone();
                const outlineMesh = new THREE.Mesh(outlineGeometry, outlineMaterial);
                
                // Copy all transforms from original mesh
                outlineMesh.position.copy(mainMesh.position);
                outlineMesh.rotation.copy(mainMesh.rotation);
                outlineMesh.scale.copy(mainMesh.scale);
                outlineMesh.quaternion.copy(mainMesh.quaternion);
                outlineMesh.matrix.copy(mainMesh.matrix);
                outlineMesh.matrixWorld.copy(mainMesh.matrixWorld);
                
                // Scale larger for more prominent outline effect
                outlineMesh.scale.multiplyScalar(1.08);
                
                // Add outline to the same parent
                if (mainMesh.parent) {
                  mainMesh.parent.add(outlineMesh);
                }
              } catch (error) {
                console.warn('Failed to create outline for mesh:', error);
              }
            } else {
              // This is not a new part, so reduce its opacity and make it grey
              if (mainMesh.material) {
                // Clone and modify materials to avoid affecting other meshes
                if (Array.isArray(mainMesh.material)) {
                  mainMesh.material = mainMesh.material.map((mat: THREE.Material) => {
                    const clonedMat = mat.clone();
                    clonedMat.transparent = true;
                    clonedMat.opacity = 0.7;
                    if ('color' in clonedMat) {
                      (clonedMat as any).color.setHex(0x888888); // Grey color
                    }
                    clonedMat.needsUpdate = true;
                    return clonedMat;
                  });
                } else {
                  const clonedMat = mainMesh.material.clone();
                  clonedMat.transparent = true;
                  clonedMat.opacity = 0.7;
                  if ('color' in clonedMat) {
                    (clonedMat as any).color.setHex(0x888888); // Grey color
                  }
                  clonedMat.needsUpdate = true;
                  mainMesh.material = clonedMat;
                }
              }
            }
          }
        });

        // Clean up
        URL.revokeObjectURL(objectUrl);
      },
      undefined,
      (error) => {
        console.error('Failed to load new parts for outlining:', error);
        URL.revokeObjectURL(objectUrl);
      }
    );
  } catch (error) {
    console.error('Error adding outlines to new parts:', error);
  }
};

interface CameraState {
  position: { x: number; y: number; z: number };
  target: { x: number; y: number; z: number };
}

export interface ExportCaptureApi {
  capturePreviewPng: () => string | null;
  capturePreviewVideo: () => Promise<{ blob: Blob; extension: 'mp4' | 'webm' } | null>;
}

const getSupportedVideoMimeType = (): { mimeType: string; extension: 'mp4' | 'webm' } | null => {
  const candidates: Array<{ mimeType: string; extension: 'mp4' | 'webm' }> = [
    { mimeType: 'video/mp4;codecs="avc1.42E01E"', extension: 'mp4' },
    { mimeType: 'video/mp4;codecs=h264', extension: 'mp4' },
    { mimeType: 'video/mp4', extension: 'mp4' },
    { mimeType: 'video/webm;codecs=vp9', extension: 'webm' },
    { mimeType: 'video/webm;codecs=vp8', extension: 'webm' },
    { mimeType: 'video/webm', extension: 'webm' },
  ];

  for (const candidate of candidates) {
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
      return candidate;
    }
  }

  return null;
};

const capturePreviewVideo = async (
  camera: THREE.PerspectiveCamera,
  controls: any,
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  animateFirstSpin = false,
): Promise<{ blob: Blob; extension: 'mp4' | 'webm' } | null> => {
  const model = scene.getObjectByName('ldraw-model');
  if (!model) return null;

  const format = getSupportedVideoMimeType();
  if (!format) {
    console.warn('No supported video format found for MediaRecorder.');
    return null;
  }

  const canvas = renderer.domElement;
  if (!canvas.captureStream) {
    console.warn('Canvas captureStream is not available in this browser.');
    return null;
  }

  const originalPosition = camera.position.clone();
  const originalTarget = controls.target.clone();
  const originalBackground = scene.background;
  const originalAutoRotate = controls.autoRotate;
  const room = scene.getObjectByName('display-room');
  const baseplate = scene.getObjectByName('baseplate');
  const rulerGrid = scene.getObjectByName('ruler-grid');
  const roomWasVisible = room ? room.visible : false;
  const baseplateWasVisible = baseplate ? baseplate.visible : false;
  const rulerGridWasVisible = rulerGrid ? rulerGrid.visible : false;

  const originalSize = new THREE.Vector2();
  renderer.getSize(originalSize);
  const originalAspect = camera.aspect;

  const fps = 40;
  const durationMs = 5000;
  const firstSpinDurationMs = durationMs / 2;
  const yAxis = new THREE.Vector3(0, 1, 0);
  const bbox = new THREE.Box3().setFromObject(model);
  const center = bbox.getCenter(new THREE.Vector3());
  const size = bbox.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  const distance = maxDimension * 1.8;
  const startAngle = THREE.MathUtils.degToRad(15);
  const baseOffset = new THREE.Vector3(-1, 0.5, 1)
    .normalize()
    .multiplyScalar(distance)
    .applyAxisAngle(yAxis, startAngle);

  // Match preview-image framing: square capture and white background.
  const previewSize = 1024;

  renderer.setSize(previewSize, previewSize, false);
  camera.aspect = 1;
  camera.updateProjectionMatrix();
  if (room) room.visible = false;
  if (baseplate) baseplate.visible = false;
  if (rulerGrid) rulerGrid.visible = false;
  scene.background = new THREE.Color(0xffffff);

  const videoBuildAnimation = animateFirstSpin
    ? createBuildAnimation(model as THREE.Group, bbox, maxDimension, firstSpinDurationMs)
    : null;

  const stream = canvas.captureStream(fps);
  const chunks: BlobPart[] = [];
  let recorder: MediaRecorder | null = null;

  try {
    recorder = new MediaRecorder(stream, {
      mimeType: format.mimeType,
      videoBitsPerSecond: 8_000_000,
    });

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const stopped = new Promise<void>((resolve, reject) => {
      recorder!.onstop = () => resolve();
      recorder!.onerror = (event) => reject(event);
    });

    controls.autoRotate = false;
    recorder.start();

    const start = performance.now();
    if (videoBuildAnimation) {
      videoBuildAnimation.startTimeMs = start;
    }

    while (true) {
      const elapsed = performance.now() - start;
      const t = Math.min(elapsed / durationMs, 1);
      const angle = t * Math.PI * 4;
      const offset = baseOffset.clone().applyAxisAngle(yAxis, angle);

      updateBuildAnimation(videoBuildAnimation, start + elapsed);
      camera.position.copy(center).add(offset);
      controls.target.copy(center);
      controls.update();
      renderer.render(scene, camera);

      if (t >= 1) break;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    recorder.stop();
    await stopped;

    const blob = new Blob(chunks, { type: format.mimeType });
    return { blob, extension: format.extension };
  } catch (err) {
    console.warn('Failed to capture preview video:', err);
    return null;
  } finally {
    completeBuildAnimation(videoBuildAnimation);
    scene.background = originalBackground;
    controls.autoRotate = originalAutoRotate;
    if (room) room.visible = roomWasVisible;
    if (baseplate) baseplate.visible = baseplateWasVisible;
    if (rulerGrid) rulerGrid.visible = rulerGridWasVisible;
    renderer.setSize(originalSize.x, originalSize.y, false);
    camera.aspect = originalAspect;
    camera.updateProjectionMatrix();
    camera.position.copy(originalPosition);
    controls.target.copy(originalTarget);
    controls.update();
    renderer.render(scene, camera);

    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
    stream.getTracks().forEach((track) => track.stop());
  }
};

type BuildAnimationPart = {
  object: THREE.Object3D;
  finalPosition: THREE.Vector3;
  startPosition: THREE.Vector3;
  delayMs: number;
  durationMs: number;
};

type BuildAnimationState = {
  active: boolean;
  startTimeMs: number;
  totalDurationMs: number;
  parts: BuildAnimationPart[];
};

type BuildAnimationCandidate = BuildAnimationPart & {
  finalWorldY: number;
};

type ExplodeMode = 'assembled' | 'exploding' | 'exploded' | 'rebuilding';

type ExplodeAnimationPart = {
  object: THREE.Object3D;
  fromPosition: THREE.Vector3;
  arcPosition: THREE.Vector3 | null;
  toPosition: THREE.Vector3;
  fromQuaternion: THREE.Quaternion;
  tumbleQuaternion: THREE.Quaternion | null;
  toQuaternion: THREE.Quaternion;
  delayMs: number;
  durationMs: number;
};

type ExplodeAnimationState = {
  active: boolean;
  direction: 'explode' | 'rebuild';
  startTimeMs: number;
  parts: ExplodeAnimationPart[];
};

type PhysicsPart = {
  object: THREE.Object3D;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  objectOffset: THREE.Vector3;
};

type ExplodePhysicsState = {
  active: boolean;
  world: RAPIER.World;
  parts: PhysicsPart[];
  collisionCount: number;
  lastStepMs: number;
  simulatedMs: number;
  maxDurationMs: number;
};

const PHYSICS_STATIC_GROUP = 0x0001;
const PHYSICS_PART_GROUP = 0x0002;

const interactionGroups = (memberships: number, filter: number) => (memberships << 16) | filter;

let rapierInitPromise: Promise<void> | null = null;

const ensureRapierReady = () => {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init();
  }
  return rapierInitPromise;
};

const easeOutCubic = (value: number) => 1 - Math.pow(1 - value, 3);

const easeInOutCubic = (value: number) => value < 0.5
  ? 4 * value * value * value
  : 1 - Math.pow(-2 * value + 2, 3) / 2;

const completeBuildAnimation = (animation: BuildAnimationState | null) => {
  if (!animation) return;
  animation.active = false;
  animation.parts.forEach((part) => {
    part.object.visible = true;
    part.object.position.copy(part.finalPosition);
  });
};

const updateBuildAnimation = (animation: BuildAnimationState | null, nowMs: number) => {
  if (!animation || !animation.active) return;

  let allComplete = true;
  const elapsedMs = nowMs - animation.startTimeMs;

  animation.parts.forEach((part) => {
    const partElapsed = elapsedMs - part.delayMs;

    if (partElapsed <= 0) {
      part.object.visible = false;
      allComplete = false;
      return;
    }

    part.object.visible = true;
    const progress = Math.min(partElapsed / part.durationMs, 1);
    const eased = easeOutCubic(progress);
    part.object.position.lerpVectors(part.startPosition, part.finalPosition, eased);

    if (progress < 1) {
      allComplete = false;
    }
  });

  if (allComplete) {
    completeBuildAnimation(animation);
  }
};

const shuffleParts = <T,>(items: T[]): T[] => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

const assignChunkedLayerDelays = (
  candidates: BuildAnimationCandidate[],
  availableDelayMs: number,
): BuildAnimationPart[] => {
  const sortedCandidates = [...candidates].sort((first, second) => first.finalWorldY - second.finalWorldY);
  const layers: BuildAnimationCandidate[][] = [];
  const layerTolerance = 8;

  sortedCandidates.forEach((candidate) => {
    const currentLayer = layers[layers.length - 1];
    if (!currentLayer || Math.abs(candidate.finalWorldY - currentLayer[0].finalWorldY) > layerTolerance) {
      layers.push([candidate]);
      return;
    }
    currentLayer.push(candidate);
  });

  const chunks = layers.flatMap((layer) => {
    const shuffledLayer = shuffleParts(layer);
    const chunkSize = Math.max(1, Math.ceil(shuffledLayer.length / THREE.MathUtils.clamp(Math.ceil(shuffledLayer.length / 4), 2, 7)));
    const layerChunks: BuildAnimationCandidate[][] = [];

    for (let index = 0; index < shuffledLayer.length; index += chunkSize) {
      layerChunks.push(shuffledLayer.slice(index, index + chunkSize));
    }

    return layerChunks;
  });

  const chunkDelayStepMs = chunks.length > 1 ? availableDelayMs / (chunks.length - 1) : 0;
  return chunks.flatMap((chunk, chunkIndex) => {
    const chunkDelayMs = chunkIndex * chunkDelayStepMs;
    return chunk.map(({ finalWorldY, ...part }) => ({
      ...part,
      delayMs: chunkDelayMs,
    }));
  });
};

const createBuildAnimation = (
  model: THREE.Group,
  bbox: THREE.Box3,
  maxDimension: number,
  totalDurationMsOverride?: number,
): BuildAnimationState | null => {
  const partGroups = model.children.filter((child) => child.name !== 'baseplate');
  if (partGroups.length === 0) return null;

  model.updateMatrixWorld(true);
  const dropHeight = Math.max(maxDimension * 0.55, 120);
  const totalDurationMs = totalDurationMsOverride ?? THREE.MathUtils.clamp(partGroups.length * 12, 2200, 4600);
  const partDurationMs = 650;
  const availableDelayMs = Math.max(totalDurationMs - partDurationMs, 0);

  const candidates = partGroups
    .map<BuildAnimationCandidate>((object) => {
      const finalWorldPosition = object.getWorldPosition(new THREE.Vector3());
      const finalPosition = object.position.clone();
      const startWorldPosition = finalWorldPosition.clone().add(new THREE.Vector3(0, dropHeight, 0));
      const startPosition = object.parent
        ? object.parent.worldToLocal(startWorldPosition)
        : startWorldPosition;

      return {
        object,
        finalPosition,
        startPosition,
        delayMs: 0,
        durationMs: partDurationMs,
        finalWorldY: finalWorldPosition.y,
      };
    });

  const parts = assignChunkedLayerDelays(candidates, availableDelayMs);

  parts.forEach((part) => {
    part.object.visible = false;
    part.object.position.copy(part.startPosition);
  });

  return {
    active: true,
    startTimeMs: performance.now(),
    totalDurationMs,
    parts,
  };
};

const getExplodableParts = (model: THREE.Group) => model.children.filter((child) => child.name !== 'baseplate');

const getStoredVector = (object: THREE.Object3D, key: string) => {
  const value = object.userData[key];
  return value instanceof THREE.Vector3 ? value.clone() : null;
};

const getStoredQuaternion = (object: THREE.Object3D, key: string) => {
  const value = object.userData[key];
  return value instanceof THREE.Quaternion ? value.clone() : null;
};

const syncObjectToBody = (part: PhysicsPart) => {
  const rotation = part.body.rotation();
  const translation = part.body.translation();
  const bodyQuaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
  const offset = part.objectOffset.clone().applyQuaternion(bodyQuaternion);
  const worldPosition = new THREE.Vector3(translation.x, translation.y, translation.z).add(offset);

  if (part.object.parent) {
    part.object.position.copy(part.object.parent.worldToLocal(worldPosition));

    const parentWorldQuaternion = part.object.parent.getWorldQuaternion(new THREE.Quaternion());
    part.object.quaternion.copy(parentWorldQuaternion.invert().multiply(bodyQuaternion));
  } else {
    part.object.position.copy(worldPosition);
    part.object.quaternion.copy(bodyQuaternion);
  }
};

const createExplodePhysics = async (
  model: THREE.Group,
  table: THREE.Object3D,
): Promise<ExplodePhysicsState | null> => {
  await ensureRapierReady();

  const allParts = getExplodableParts(model);
  if (allParts.length === 0) return null;

  model.updateMatrixWorld(true);
  const modelBounds = new THREE.Box3().setFromObject(model);
  const modelCenter = modelBounds.getCenter(new THREE.Vector3());
  const modelSize = modelBounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(modelSize.x, modelSize.y, modelSize.z);
  const tableTopSurface = typeof table.userData.tableTopSurface === 'number' ? table.userData.tableTopSurface : 0;
  const tableThickness = typeof table.userData.tableThickness === 'number' ? table.userData.tableThickness : 12;
  const tableWidth = typeof table.userData.tableWidth === 'number' ? table.userData.tableWidth : 300;
  const tableDepth = typeof table.userData.tableDepth === 'number' ? table.userData.tableDepth : 300;
  const tableCenterX = typeof table.userData.tableCenterX === 'number' ? table.userData.tableCenterX : 0;
  const tableCenterZ = typeof table.userData.tableCenterZ === 'number' ? table.userData.tableCenterZ : 0;
  const floorY = typeof table.userData.floorY === 'number' ? table.userData.floorY : tableTopSurface - 220;
  const roomWidth = typeof table.userData.roomWidth === 'number' ? table.userData.roomWidth : tableWidth * 2;
  const roomDepth = typeof table.userData.roomDepth === 'number' ? table.userData.roomDepth : tableDepth * 2;

  allParts.forEach((object) => {
    if (!getStoredVector(object, 'explodeOriginalPosition')) {
      object.userData.explodeOriginalPosition = object.position.clone();
      object.userData.explodeOriginalQuaternion = object.quaternion.clone();
    }
  });

  const parts = allParts;
  model.updateMatrixWorld(true);

  const world = new RAPIER.World({ x: 0, y: -560, z: 0 });
  world.timestep = 1 / 60;
  world.numSolverIterations = 5;
  world.maxCcdSubsteps = 1;
  world.lengthUnit = Math.max(maxDimension / 8, 20);

  const staticGroups = interactionGroups(PHYSICS_STATIC_GROUP, PHYSICS_PART_GROUP);
  const partGroups = interactionGroups(PHYSICS_PART_GROUP, PHYSICS_STATIC_GROUP);

  const tableBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(tableCenterX, tableTopSurface - tableThickness / 2, tableCenterZ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(tableWidth / 2, tableThickness / 2, tableDepth / 2)
      .setFriction(0.55)
      .setRestitution(0.22)
      .setCollisionGroups(staticGroups)
      .setSolverGroups(staticGroups),
    tableBody,
  );

  const floorBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(tableCenterX, floorY - 8, tableCenterZ),
  );
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(roomWidth / 2, 8, roomDepth / 2)
      .setFriction(0.55)
      .setRestitution(0.22)
      .setCollisionGroups(staticGroups)
      .setSolverGroups(staticGroups),
    floorBody,
  );

  const physicsParts = parts.flatMap<PhysicsPart>((object, index) => {
    object.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return [];

    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const objectWorldPosition = object.getWorldPosition(new THREE.Vector3());
    const objectWorldQuaternion = object.getWorldQuaternion(new THREE.Quaternion());
    const inverseWorldQuaternion = objectWorldQuaternion.clone().invert();
    const objectOffset = objectWorldPosition.clone().sub(center).applyQuaternion(inverseWorldQuaternion);
    const outward = center.clone().sub(modelCenter);
    outward.y = 0;
    if (outward.lengthSq() < 0.001) {
      outward.set(Math.sin(index * 1.91), 0, Math.cos(index * 2.43));
    }
    outward.normalize();

    const radialSpeed = THREE.MathUtils.clamp(maxDimension * 1.05, 170, 500);
    const spread = Math.random();
    const radialMultiplier = THREE.MathUtils.lerp(0.22, 1.08, spread * spread);
    const tangent = new THREE.Vector3(-outward.z, 0, outward.x);
    const tangentSpeed = THREE.MathUtils.lerp(-105, 105, Math.random());
    const randomX = THREE.MathUtils.lerp(-42, 42, Math.random());
    const randomZ = THREE.MathUtils.lerp(-42, 42, Math.random());

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({
          x: objectWorldQuaternion.x,
          y: objectWorldQuaternion.y,
          z: objectWorldQuaternion.z,
          w: objectWorldQuaternion.w,
        })
        .setLinvel(
          outward.x * radialSpeed * radialMultiplier + tangent.x * tangentSpeed + randomX,
          THREE.MathUtils.clamp(maxDimension * 0.78, 180, 360) + (index % 6) * 18,
          outward.z * radialSpeed * radialMultiplier + tangent.z * tangentSpeed + randomZ,
        )
        .setAngvel({
          x: Math.sin(index * 1.37) * 5.5,
          y: Math.cos(index * 1.83) * 4.5,
          z: Math.sin(index * 2.21) * 5,
        })
        .setAdditionalMass(THREE.MathUtils.clamp((size.x * size.y * size.z) / 18000, 0.35, 3.5))
        .setLinearDamping(0.18)
        .setAngularDamping(0.28)
        .setCanSleep(true),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        Math.max(size.x / 2, 3),
        Math.max(size.y / 2, 3),
        Math.max(size.z / 2, 3),
      )
        .setFriction(0.55)
        .setRestitution(0.22)
        .setCollisionGroups(partGroups)
        .setSolverGroups(partGroups),
      body,
    );

    return [{
      object,
      body,
      collider,
      objectOffset,
    }];
  });

  if (physicsParts.length === 0) return null;

  return {
    active: true,
    world,
    parts: physicsParts,
    collisionCount: 0,
    lastStepMs: performance.now(),
    simulatedMs: 0,
    maxDurationMs: 9000,
  };
};

const completeExplodePhysics = (physics: ExplodePhysicsState | null) => {
  if (!physics) return;
  physics.active = false;
  physics.parts.forEach(syncObjectToBody);
  physics.world.free();
};

const stopExplodePhysicsAtCurrentPose = (physics: ExplodePhysicsState | null) => {
  if (!physics) return;
  physics.active = false;
  physics.parts.forEach(syncObjectToBody);
  physics.world.free();
};

const countRapierContacts = (physics: ExplodePhysicsState) => {
  let contactCount = 0;
  physics.parts.forEach((part) => {
    physics.world.contactPairsWith(part.collider, (otherCollider) => {
      physics.world.narrowPhase.contactPair(part.collider.handle, otherCollider.handle, (manifold) => {
        contactCount += manifold.numContacts();
      });
    });
  });
  return contactCount;
};

const updateExplodePhysics = (physics: ExplodePhysicsState | null, nowMs: number) => {
  if (!physics || !physics.active) return false;

  const deltaSeconds = Math.min((nowMs - physics.lastStepMs) / 1000, 0.05);
  physics.lastStepMs = nowMs;
  physics.world.timestep = deltaSeconds;
  physics.world.step();
  physics.collisionCount = countRapierContacts(physics);
  physics.simulatedMs += deltaSeconds * 1000;
  physics.parts.forEach(syncObjectToBody);

  const elapsedMs = physics.simulatedMs;
  const allSleeping = physics.parts.every((part) => part.body.isSleeping());
  if (elapsedMs < 1200 || (!allSleeping && elapsedMs < physics.maxDurationMs)) return false;

  completeExplodePhysics(physics);
  return true;
};

const computeTableLandingTransform = (
  object: THREE.Object3D,
  table: THREE.Object3D,
  index: number,
  partCount: number,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } => {
  const parent = object.parent;
  const originalPosition = object.position.clone();
  const originalQuaternion = object.quaternion.clone();
  const tableTopSurface = typeof table.userData.tableTopSurface === 'number' ? table.userData.tableTopSurface : 0;
  const tableWidth = typeof table.userData.tableWidth === 'number' ? table.userData.tableWidth : 300;
  const tableDepth = typeof table.userData.tableDepth === 'number' ? table.userData.tableDepth : 300;
  const tableCenterX = typeof table.userData.tableCenterX === 'number' ? table.userData.tableCenterX : 0;
  const tableCenterZ = typeof table.userData.tableCenterZ === 'number' ? table.userData.tableCenterZ : 0;
  const aspect = Math.max(tableWidth / Math.max(tableDepth, 1), 0.35);
  const columns = Math.max(1, Math.ceil(Math.sqrt(partCount * aspect)));
  const rows = Math.max(1, Math.ceil(partCount / columns));
  const usableWidth = tableWidth * 0.78;
  const usableDepth = tableDepth * 0.78;
  const cellWidth = usableWidth / columns;
  const cellDepth = usableDepth / rows;
  const column = index % columns;
  const row = Math.floor(index / columns);
  const jitterSeed = Math.sin((index + 1) * 12.9898) * 43758.5453;
  const jitter = jitterSeed - Math.floor(jitterSeed);
  const xJitter = (jitter - 0.5) * cellWidth * 0.35;
  const zJitter = (Math.sin((index + 1) * 78.233) - Math.floor(Math.sin((index + 1) * 78.233))) * cellDepth * 0.25;
  const targetWorld = new THREE.Vector3(
    tableCenterX - usableWidth / 2 + cellWidth * (column + 0.5) + xJitter,
    tableTopSurface + 24,
    tableCenterZ - usableDepth / 2 + cellDepth * (row + 0.5) + zJitter,
  );
  const targetPosition = parent ? parent.worldToLocal(targetWorld.clone()) : targetWorld;
  const layFlatX = index % 2 === 0 ? Math.PI / 2 : -Math.PI / 2;
  const layFlatZ = index % 3 === 0 ? Math.PI / 2 : 0;
  const targetQuaternion = originalQuaternion.clone().multiply(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      layFlatX,
      (index % 8) * Math.PI / 4,
      layFlatZ,
    )),
  );

  object.position.copy(targetPosition);
  object.quaternion.copy(targetQuaternion);
  object.updateMatrixWorld(true);

  const partBounds = new THREE.Box3().setFromObject(object);
  const yCorrection = tableTopSurface + 1 - partBounds.min.y;
  const currentWorldPosition = object.getWorldPosition(new THREE.Vector3());
  const correctedWorldPosition = currentWorldPosition.add(new THREE.Vector3(0, yCorrection, 0));
  const correctedPosition = parent ? parent.worldToLocal(correctedWorldPosition) : correctedWorldPosition;

  object.position.copy(originalPosition);
  object.quaternion.copy(originalQuaternion);
  object.updateMatrixWorld(true);

  return { position: correctedPosition, quaternion: targetQuaternion };
};

const createExplodeAnimation = (
  model: THREE.Group,
  table: THREE.Object3D,
  direction: 'explode' | 'rebuild',
): ExplodeAnimationState | null => {
  const parts = getExplodableParts(model);
  if (parts.length === 0) return null;

  model.updateMatrixWorld(true);
  const modelBounds = new THREE.Box3().setFromObject(model);
  const modelCenter = modelBounds.getCenter(new THREE.Vector3());
  const modelSize = modelBounds.getSize(new THREE.Vector3());
  const blastHeight = THREE.MathUtils.clamp(Math.max(modelSize.x, modelSize.y, modelSize.z) * 0.5, 90, 340);
  const maxDistance = Math.max(...parts.map((part) => part.getWorldPosition(new THREE.Vector3()).distanceTo(modelCenter)), 1);

  const animationParts = parts.map<ExplodeAnimationPart>((object, index) => {
    if (!getStoredVector(object, 'explodeOriginalPosition')) {
      object.userData.explodeOriginalPosition = object.position.clone();
      object.userData.explodeOriginalQuaternion = object.quaternion.clone();
    }

    const originalPosition = getStoredVector(object, 'explodeOriginalPosition') ?? object.position.clone();
    const originalQuaternion = getStoredQuaternion(object, 'explodeOriginalQuaternion') ?? object.quaternion.clone();
    const landing = computeTableLandingTransform(object, table, index, parts.length);
    object.userData.explodeTargetPosition = landing.position.clone();
    object.userData.explodeTargetQuaternion = landing.quaternion.clone();

    const currentWorldPosition = object.getWorldPosition(new THREE.Vector3());
    const landingWorldPosition = object.parent
      ? object.parent.localToWorld(landing.position.clone())
      : landing.position.clone();
    const distanceDelay = currentWorldPosition.distanceTo(modelCenter) / maxDistance;
    const outwardDirection = currentWorldPosition.clone().sub(modelCenter);
    if (outwardDirection.lengthSq() < 0.001) {
      outwardDirection.set(Math.sin(index * 2.17), 0, Math.cos(index * 1.73));
    }
    outwardDirection.y = 0;
    outwardDirection.normalize();

    const popProgress = 0.25 + (index % 5) * 0.055;
    const popWorldPosition = currentWorldPosition.clone().lerp(landingWorldPosition, popProgress);
    popWorldPosition.add(outwardDirection.multiplyScalar(blastHeight * (0.18 + (index % 4) * 0.035)));
    popWorldPosition.y = Math.max(currentWorldPosition.y, landingWorldPosition.y) + blastHeight * (0.78 + (index % 6) * 0.055);

    const arcPosition = object.parent
      ? object.parent.worldToLocal(popWorldPosition.clone())
      : popWorldPosition;
    const tumbleQuaternion = object.quaternion.clone().multiply(
      new THREE.Quaternion().setFromEuler(new THREE.Euler(
        Math.PI * (1.25 + (index % 3) * 0.35),
        Math.PI * (0.85 + (index % 5) * 0.22),
        Math.PI * (0.55 + (index % 4) * 0.3),
      )),
    );
    const delayMs = direction === 'explode' ? distanceDelay * 170 : (1 - distanceDelay) * 140;

    return {
      object,
      fromPosition: object.position.clone(),
      arcPosition: direction === 'explode' ? arcPosition : null,
      toPosition: direction === 'explode' ? landing.position : originalPosition,
      fromQuaternion: object.quaternion.clone(),
      tumbleQuaternion: direction === 'explode' ? tumbleQuaternion : null,
      toQuaternion: direction === 'explode' ? landing.quaternion : originalQuaternion,
      delayMs,
      durationMs: direction === 'explode' ? 1350 : 850,
    };
  });

  return {
    active: true,
    direction,
    startTimeMs: performance.now(),
    parts: animationParts,
  };
};

const completeExplodeAnimation = (animation: ExplodeAnimationState | null) => {
  if (!animation) return;
  animation.active = false;
  animation.parts.forEach((part) => {
    part.object.visible = true;
    part.object.position.copy(part.toPosition);
    part.object.quaternion.copy(part.toQuaternion);
  });
};

const updateExplodeAnimation = (animation: ExplodeAnimationState | null, nowMs: number) => {
  if (!animation || !animation.active) return null;

  let allComplete = true;
  const elapsedMs = nowMs - animation.startTimeMs;

  animation.parts.forEach((part) => {
    const partElapsed = elapsedMs - part.delayMs;

    if (partElapsed <= 0) {
      allComplete = false;
      return;
    }

    const progress = Math.min(partElapsed / part.durationMs, 1);
    const eased = part.arcPosition ? progress : easeInOutCubic(progress);
    part.object.visible = true;

    if (part.arcPosition) {
      const firstLeg = part.fromPosition.clone().lerp(part.arcPosition, eased);
      const secondLeg = part.arcPosition.clone().lerp(part.toPosition, eased);
      part.object.position.copy(firstLeg.lerp(secondLeg, eased));
    } else {
      part.object.position.lerpVectors(part.fromPosition, part.toPosition, eased);
    }

    if (part.tumbleQuaternion && progress < 0.58) {
      part.object.quaternion.slerpQuaternions(part.fromQuaternion, part.tumbleQuaternion, easeOutCubic(progress / 0.58));
    } else if (part.tumbleQuaternion) {
      part.object.quaternion.slerpQuaternions(part.tumbleQuaternion, part.toQuaternion, easeInOutCubic((progress - 0.58) / 0.42));
    } else {
      part.object.quaternion.slerpQuaternions(part.fromQuaternion, part.toQuaternion, eased);
    }

    if (progress < 1) {
      allComplete = false;
    }
  });

  if (!allComplete) return null;

  const completedDirection = animation.direction;
  completeExplodeAnimation(animation);
  return completedDirection;
};

interface ThreeLDRViewerProps {
  modelPath?: string;
  modelContent?: string;
  modelName?: string;
  generationId?: string;
  className?: string;
  autoRotate?: boolean;
  initialCameraState?: CameraState;
  onCameraChange?: (cameraState: CameraState) => void;
  preserveOrientation?: boolean;
  highlightNewParts?: boolean;
  newPartsContent?: string;
  onScreenshotsReady?: (screenshots: { angle1: string; angle2: string }) => void;
  // Called once after the model finishes loading with a PNG data URL of just
  // the model on a pure white background (no table/floor/walls/baseplate).
  onPreviewCaptured?: (dataUrl: string) => void;
  // Called once after the model finishes loading and is positioned in the
  // scene. Useful for triggering UI transitions after the 3D scene is ready.
  onModelLoaded?: () => void;
  // Provides imperative capture methods for export options in the parent UI.
  onExportCaptureReady?: (api: ExportCaptureApi | null) => void;
  softenEdges?: boolean;     // Whether to soften brick edge lines (default true)
  // Step-aware props for instant step navigation
  currentStepIndex?: number;  // 0-indexed, show parts up to and including this step
  totalSteps?: number;        // Total number of steps in model
  showBaseplate?: boolean;    // Whether to show baseplate with studs
  animateModelBuild?: boolean; // Whether to drop parts into place on load
}

// Parse step boundaries from MPD content - returns array of cumulative part counts per step
const parseStepBoundaries = (mpdContent: string): number[] => {
  const lines = mpdContent.split('\n');
  const stepBoundaries: number[] = [];
  let partCount = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Stop at subfile section
    if (trimmed.startsWith('0 FILE') && stepBoundaries.length > 0) break;
    
    if (trimmed.startsWith('1 ')) {
      partCount++;
    } else if (trimmed === '0 STEP') {
      stepBoundaries.push(partCount); // Total parts up to this step
    }
  }
  
  return stepBoundaries;
};

export function ThreeLDRViewer({ 
  modelPath = '/test.ldr_Packed.mpd',
  modelContent,
  modelName,
  generationId,
  className = '',
  autoRotate = true,
  initialCameraState,
  onCameraChange,
  preserveOrientation = false,
  highlightNewParts = false,
  newPartsContent,
  onScreenshotsReady,
  onPreviewCaptured,
  onModelLoaded,
  onExportCaptureReady,
  softenEdges = true,
  currentStepIndex,
  totalSteps,
  showBaseplate = false,
  animateModelBuild = false
}: ThreeLDRViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Store mesh references for step-based visibility
  const meshesRef = useRef<THREE.Object3D[]>([]);
  const stepBoundariesRef = useRef<number[]>([]);
  // Store original materials for each part group (to restore when it becomes current step)
  const originalMaterialsRef = useRef<Map<THREE.Object3D, Map<THREE.Mesh, THREE.Material | THREE.Material[]>>>(new Map());
  // Grey transparent material for previous steps
  const greyMaterialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  // Track when meshes are ready to trigger material effect
  const [meshesReady, setMeshesReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [explodeMode, setExplodeMode] = useState<ExplodeMode>('assembled');
  const [showRulerGrid, setShowRulerGrid] = useState(false);
  const collisionCountRef = useRef(0);
  const isCaptureInProgressRef = useRef(false);
  const buildAnimationRef = useRef<BuildAnimationState | null>(null);
  const explodeAnimationRef = useRef<ExplodeAnimationState | null>(null);
  const explodePhysicsRef = useRef<ExplodePhysicsState | null>(null);
  
  const sceneRef = useRef<{
    scene: THREE.Scene | null;
    camera: THREE.PerspectiveCamera | null;
    renderer: THREE.WebGLRenderer | null;
    controls: any;
    animationId: number | null;
  }>({
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    animationId: null
  });

  const canExplodeModel = !loading && !error && currentStepIndex === undefined;

  const updateCollisionCount = (nextCount: number) => {
    if (collisionCountRef.current === nextCount) return;
    collisionCountRef.current = nextCount;
  };

  const handleToggleExplode = async () => {
    const { scene, controls } = sceneRef.current;
    const model = scene?.getObjectByName('ldraw-model') as THREE.Group | undefined;
    const table = scene?.getObjectByName('display-table');
    if (!model || !table || explodeMode === 'rebuilding') return;

    completeBuildAnimation(buildAnimationRef.current);
    buildAnimationRef.current = null;
    if (controls?.autoRotate) {
      controls.autoRotate = false;
    }

    const direction = explodeMode === 'assembled' ? 'explode' : 'rebuild';
    if (direction === 'explode') {
      completeExplodePhysics(explodePhysicsRef.current);
      explodePhysicsRef.current = null;
      explodeAnimationRef.current = null;
      explodePhysicsRef.current = await createExplodePhysics(model, table);
      if (!explodePhysicsRef.current) return;
      updateCollisionCount(0);
      setExplodeMode('exploding');
      return;
    }

    stopExplodePhysicsAtCurrentPose(explodePhysicsRef.current);
    explodePhysicsRef.current = null;
    updateCollisionCount(0);

    const animation = createExplodeAnimation(model, table, direction);
    if (!animation) return;
    explodeAnimationRef.current = animation;
    setExplodeMode('rebuilding');
  };

  useEffect(() => {
    if (!containerRef.current) return;
    
    // Reset meshesReady for new model load
    setMeshesReady(false);
    setExplodeMode('assembled');
    updateCollisionCount(0);
    stopExplodePhysicsAtCurrentPose(explodePhysicsRef.current);
    buildAnimationRef.current = null;
    explodeAnimationRef.current = null;
    explodePhysicsRef.current = null;

    const initThreeJS = async () => {
      try {
        const container = containerRef.current!;
        const width = container.clientWidth;
        const height = container.clientHeight || 400; // Use container's height or fallback to 400px
        
        // Scene setup
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf5f0e8); // warm off-white

        // Camera setup
        const camera = new THREE.PerspectiveCamera(45, width / height, 1, 10000);
        camera.position.set(150, 200, 250);

        // Renderer setup
        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(width, height);
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.85;
        container.appendChild(renderer.domElement);

        // Environment setup (soft studio lighting for reflections)
        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        scene.environment = pmremGenerator.fromScene(new RoomEnvironment()).texture;

        // Enable shadows for the room
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        // Key light (casts shadows) – kept subtle since RoomEnvironment already lights the scene
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

        // Soft fill light from opposite side
        const fillLight = new THREE.DirectionalLight(0xe8f0ff, 0.3);
        fillLight.position.set(-150, 200, -100);
        scene.add(fillLight);

        // Ambient to fill darkest areas
        const ambient = new THREE.AmbientLight(0xffffff, 0.15);
        scene.add(ambient);

        // Controls setup
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.1;
        controls.autoRotate = autoRotate;
        controls.autoRotateSpeed = 1.5;

        // Disable auto-rotate when user interacts (only if auto-rotate is enabled)
        if (autoRotate) {
          const disableAutoRotate = () => {
            if (controls.autoRotate) {
              controls.autoRotate = false;
              renderer.domElement.removeEventListener('pointerdown', disableAutoRotate);
              renderer.domElement.removeEventListener('wheel', disableAutoRotate);
              renderer.domElement.removeEventListener('touchstart', disableAutoRotate);
            }
          };
          renderer.domElement.addEventListener('pointerdown', disableAutoRotate);
          renderer.domElement.addEventListener('wheel', disableAutoRotate);
          renderer.domElement.addEventListener('touchstart', disableAutoRotate);
        }

        // Add camera change listener to track orientation
        if (onCameraChange) {
          const handleCameraChange = () => {
            const cameraState: CameraState = {
              position: {
                x: camera.position.x,
                y: camera.position.y,
                z: camera.position.z
              },
              target: {
                x: controls.target.x,
                y: controls.target.y,
                z: controls.target.z
              }
            };
            onCameraChange(cameraState);
          };
          
          controls.addEventListener('change', handleCameraChange);
        }

        // Add camera change listener to track orientation
        if (onCameraChange) {
          const handleCameraChange = () => {
            const cameraState: CameraState = {
              position: {
                x: camera.position.x,
                y: camera.position.y,
                z: camera.position.z
              },
              target: {
                x: controls.target.x,
                y: controls.target.y,
                z: controls.target.z
              }
            };
            onCameraChange(cameraState);
          };
          
          controls.addEventListener('change', handleCameraChange);
        }

        // Store references
        sceneRef.current = { scene, camera, renderer, controls, animationId: null };

        // Load the actual LDraw model
        const loadLDrawModel = async () => {
          const lDrawLoader = new LDrawLoader();
          
          // Configure the loader
          lDrawLoader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
          lDrawLoader.smoothNormals = false;
          
          // Determine what to load
          let modelSource: string;
          let objectUrl: string | null = null;
          
          if (modelContent) {
            // Create a data URL for the model content
            const blob = new Blob([modelContent], { type: 'text/plain' });
            objectUrl = URL.createObjectURL(blob);
            modelSource = objectUrl;
          } else {
            modelSource = modelPath;
          }
          
          // Load the model
          lDrawLoader.load(
            modelSource,
            (model: THREE.Group) => {
              
              // Clear any existing models
              const existingModel = scene.getObjectByName('ldraw-model');
              if (existingModel) {
                scene.remove(existingModel);
              }
              
              // Rotate the model to match the original implementation
              model.rotation.x = Math.PI;
              model.name = 'ldraw-model';
              scene.add(model);

              // Collect direct children (part groups) for step-based visibility control
              // Each direct child of the model corresponds to one part reference (one "1 " line)
              if (modelContent && currentStepIndex !== undefined) {
                // Direct children are part groups, not individual meshes
                const partGroups = model.children.slice();
                stepBoundariesRef.current = parseStepBoundaries(modelContent);
                meshesRef.current = partGroups;
                
                // Apply initial visibility based on current step
                const visibleCount = stepBoundariesRef.current[currentStepIndex] ?? partGroups.length;
                partGroups.forEach((part, idx) => {
                  part.visible = idx < visibleCount;
                });
                
                // Trigger material effect
                setMeshesReady(true);
              }

              // Soften brick edge lines by making them lighter and semi-transparent
              if (softenEdges) {
                model.traverse((obj) => {
                  if (obj.type === 'LineSegments' || obj.type === 'Line2' || obj.type === 'Line') {
                    const line = obj as THREE.LineSegments;
                    if (line.material) {
                      const mats = Array.isArray(line.material) ? line.material : [line.material];
                      mats.forEach((mat) => {
                        mat.transparent = true;
                        mat.opacity = 0.2;
                        if ('color' in mat) {
                          (mat as any).color.lerp(new THREE.Color(0x999999), 0.6);
                        }
                        mat.needsUpdate = true;
                      });
                    }
                  }
                });
              }

              // Add outline effect to new parts if highlighting is enabled
              if (highlightNewParts && newPartsContent) {
                addOutlineToNewParts(model, newPartsContent, scene);
              }

              // Calculate bounding box and adjust camera to fit model optimally
              const bbox = new THREE.Box3().setFromObject(model);
              const size = bbox.getSize(new THREE.Vector3());
              const maxDimension = Math.max(size.x, size.y, size.z);
              const center = bbox.getCenter(new THREE.Vector3());
              
              // Calculate minimum distance needed to fit the model (50% more zoomed out)
              const minDistance = maxDimension * 1.8;

              buildRulerGrid(scene, bbox, maxDimension);
              const rulerGrid = scene.getObjectByName('ruler-grid');
              if (rulerGrid) rulerGrid.visible = false;

              // ── Build display room with table ──
              buildRoom(scene, bbox, center, size, maxDimension, showBaseplate);
              
              if (preserveOrientation && initialCameraState) {
                // Preserve orientation but ensure zoom is sufficient to fit model
                const currentDistance = new THREE.Vector3(
                  initialCameraState.position.x - center.x,
                  initialCameraState.position.y - center.y,
                  initialCameraState.position.z - center.z
                ).length();
                
                // Use the larger of current distance or minimum required distance
                const finalDistance = Math.max(currentDistance, minDistance);
                
                // Calculate viewing direction from preserved state
                const direction = new THREE.Vector3(
                  initialCameraState.position.x - initialCameraState.target.x,
                  initialCameraState.position.y - initialCameraState.target.y,
                  initialCameraState.position.z - initialCameraState.target.z
                ).normalize();
                
                // Set camera with preserved direction but adjusted distance
                camera.position.copy(center).add(direction.multiplyScalar(finalDistance));
                controls.target.copy(center);
                controls.update();
              } else {
                // Match the front-left screenshot angle
                const camOffset = new THREE.Vector3(-1, 0.5, 1).normalize().multiplyScalar(minDistance);
                camera.position.copy(center).add(camOffset);

                controls.target.copy(center);
                
                // Make sure controls are updated
                controls.update();
              }
              
              // Add gray baseplate with studs at floor level (if enabled)
              const existingBaseplate = scene.getObjectByName('baseplate');
              if (existingBaseplate) {
                scene.remove(existingBaseplate);
              }
              
              if (showBaseplate) {
              // LDraw units: 1 stud spacing = 20 LDU
              const studSpacing = 20;
              const studRadius = 6; // ~12 LDU diameter
              const studHeight = 4;
              
              // Calculate baseplate bounds snapped to stud grid
              const padding = studSpacing * 2; // 2 studs of padding
              const minX = Math.floor((bbox.min.x - padding) / studSpacing) * studSpacing;
              const maxX = Math.ceil((bbox.max.x + padding) / studSpacing) * studSpacing;
              const minZ = Math.floor((bbox.min.z - padding) / studSpacing) * studSpacing;
              const maxZ = Math.ceil((bbox.max.z + padding) / studSpacing) * studSpacing;
              
              const baseplateWidth = maxX - minX;
              const baseplateDepth = maxZ - minZ;
              const baseplateCenterX = (minX + maxX) / 2;
              const baseplateCenterZ = (minZ + maxZ) / 2;
              
              // Create baseplate group
              const baseplateGroup = new THREE.Group();
              baseplateGroup.name = 'baseplate';
              baseplateGroup.userData.floorY = bbox.min.y;
              
              // Create the flat base
              const baseGeometry = new THREE.BoxGeometry(baseplateWidth, 4, baseplateDepth);
              const baseMaterial = new THREE.MeshStandardMaterial({ 
                color: 0x9e9e9e,
                roughness: 0.8,
                metalness: 0.1
              });
              const baseMesh = new THREE.Mesh(baseGeometry, baseMaterial);
              baseMesh.position.set(baseplateCenterX, bbox.min.y - 2, baseplateCenterZ);
              baseMesh.receiveShadow = true;
              baseplateGroup.add(baseMesh);
              
              // Create stud geometry (reused for all studs)
              const studGeometry = new THREE.CylinderGeometry(studRadius, studRadius, studHeight, 16);
              const studMaterial = new THREE.MeshStandardMaterial({ 
                color: 0xa8a8a8,
                roughness: 0.7,
                metalness: 0.1
              });
              
              // Add studs at grid positions
              for (let x = minX + studSpacing / 2; x < maxX; x += studSpacing) {
                for (let z = minZ + studSpacing / 2; z < maxZ; z += studSpacing) {
                  const stud = new THREE.Mesh(studGeometry, studMaterial);
                  stud.position.set(x, bbox.min.y + studHeight / 2, z);
                  stud.castShadow = true;
                  baseplateGroup.add(stud);
                }
              }
              
              scene.add(baseplateGroup);
              }

              if (animateModelBuild && currentStepIndex === undefined) {
                buildAnimationRef.current = createBuildAnimation(model, bbox, maxDimension);
              } else {
                buildAnimationRef.current = null;
              }
              
              // Model is loaded and positioned - hide loading spinner immediately
              setLoading(false);

              // Notify caller that the 3D scene is loaded and ready to view
              if (onModelLoaded) {
                onModelLoaded();
              }

              if (onExportCaptureReady) {
                onExportCaptureReady({
                  capturePreviewPng: () => {
                    isCaptureInProgressRef.current = true;
                    try {
                      completeBuildAnimation(buildAnimationRef.current);
                      return captureCleanPreview(camera, controls, renderer, scene);
                    } finally {
                      isCaptureInProgressRef.current = false;
                    }
                  },
                  capturePreviewVideo: async () => {
                    isCaptureInProgressRef.current = true;
                    try {
                      completeBuildAnimation(buildAnimationRef.current);
                      return await capturePreviewVideo(camera, controls, renderer, scene, animateModelBuild);
                    } finally {
                      isCaptureInProgressRef.current = false;
                    }
                  },
                });
              }
              
              // Capture screenshots if callback provided
              if (onScreenshotsReady) {
                setTimeout(() => {
                  isCaptureInProgressRef.current = true;
                  try {
                    captureScreenshots(camera, controls, renderer, scene, onScreenshotsReady);
                  } finally {
                    isCaptureInProgressRef.current = false;
                  }
                }, 100); // Small delay to ensure rendering is complete
              }

              // Capture clean white-background preview if callback provided
              if (onPreviewCaptured) {
                setTimeout(() => {
                  isCaptureInProgressRef.current = true;
                  try {
                    completeBuildAnimation(buildAnimationRef.current);
                    const dataUrl = captureCleanPreview(camera, controls, renderer, scene);
                    if (dataUrl) {
                      onPreviewCaptured(dataUrl);
                    }
                  } finally {
                    isCaptureInProgressRef.current = false;
                  }
                }, animateModelBuild && buildAnimationRef.current ? buildAnimationRef.current.totalDurationMs + 200 : 150); // Slightly after screenshots so we don't fight over camera state
              }
              
              // Clean up object URL if it was created
              if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
              }
            },
            (progress: ProgressEvent) => {
              // Handle loading progress
              if (progress.total > 0) {
                const percentage = (progress.loaded / progress.total * 100).toFixed(1);
              }
            },
            (error: any) => {
              console.error('Failed to load LDraw model:', error);
              setError(`Failed to load LDR model: ${error.message || 'Unknown error'}`);
              
              // Clean up object URL if it was created
              if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
              }
              
              setLoading(false);
            }
          );
        };

        // Try to load the LDraw model
        try {
          loadLDrawModel().catch((modelError) => {
            console.error('Failed to initialize LDraw loader:', modelError);
            setError('Failed to initialize LDraw loader');
            setLoading(false);
          });
        } catch (modelError) {
          console.error('Failed to initialize LDraw loader:', modelError);
          setError('Failed to initialize LDraw loader');
          setLoading(false);
        }

        // Animation loop
        const animate = () => {
          sceneRef.current.animationId = requestAnimationFrame(animate);

          if (isCaptureInProgressRef.current) {
            return;
          }

          const nowMs = performance.now();
          updateBuildAnimation(buildAnimationRef.current, nowMs);
          const completedExplodeDirection = updateExplodeAnimation(explodeAnimationRef.current, nowMs);
          if (completedExplodeDirection) {
            explodeAnimationRef.current = null;
            explodePhysicsRef.current = null;
            setExplodeMode(completedExplodeDirection === 'rebuild' ? 'assembled' : 'exploded');
          }
          const physicsCompleted = updateExplodePhysics(explodePhysicsRef.current, nowMs);
          if (physicsCompleted) {
            explodePhysicsRef.current = null;
            updateCollisionCount(0);
            setExplodeMode('exploded');
          } else {
            updateCollisionCount(explodePhysicsRef.current?.collisionCount ?? 0);
          }
          controls.update();
          
          // Hide table when camera rotates underneath the model so the underside
          // remains visible. Keep room walls/floor visible.
          const displayTable = scene.getObjectByName('display-table');
          if (displayTable) {
            // Hide only once the camera drops below the table's top surface,
            // so side views keep the table visible longer.
            const hideBelowY = typeof displayTable.userData.hideBelowY === 'number'
              ? displayTable.userData.hideBelowY
              : controls.target.y;
            const isUnderModel = camera.position.y < hideBelowY - 1;
            displayTable.visible = !isUnderModel;
          }

          // Hide baseplate when camera is below the model/baseplate plane.
          // This is evaluated independently from the table visibility logic.
          const baseplate = scene.getObjectByName('baseplate');
          if (baseplate) {
            const floorY = baseplate.userData.floorY ?? 0;
            const isAbove = camera.position.y > floorY;
            baseplate.visible = isAbove;
          }

          updateRulerLabelScales(scene, camera, renderer);
          
          renderer.render(scene, camera);
        };
        animate();

        // Handle resize
        const handleResize = () => {
          if (!containerRef.current) return;
          const newWidth = containerRef.current.clientWidth;
          const newHeight = containerRef.current.clientHeight || 400; // Fallback height
          camera.aspect = newWidth / newHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(newWidth, newHeight);
        };

        window.addEventListener('resize', handleResize);

        return () => {
          window.removeEventListener('resize', handleResize);
        };

      } catch (error) {
        console.error('Failed to initialize Three.js LDR viewer:', error);
        setError('Failed to initialize 3D viewer');
        setLoading(false);
      }
    };

    initThreeJS();

    // Cleanup
    return () => {
      if (onExportCaptureReady) {
        onExportCaptureReady(null);
      }
      if (sceneRef.current.animationId) {
        cancelAnimationFrame(sceneRef.current.animationId);
      }
      stopExplodePhysicsAtCurrentPose(explodePhysicsRef.current);
      explodePhysicsRef.current = null;
      if (sceneRef.current.renderer) {
        sceneRef.current.renderer.dispose();
        if (containerRef.current && sceneRef.current.renderer.domElement) {
          containerRef.current.removeChild(sceneRef.current.renderer.domElement);
        }
      }
    };
  }, [modelPath, modelContent, onExportCaptureReady, animateModelBuild]);

  useEffect(() => {
    const { scene } = sceneRef.current;
    const rulerGrid = scene?.getObjectByName('ruler-grid');
    if (!rulerGrid) return;

    const visibleCount = currentStepIndex === undefined
      ? meshesRef.current.length || 1
      : stepBoundariesRef.current[currentStepIndex] ?? meshesRef.current.length;
    rulerGrid.visible = showRulerGrid && visibleCount > 0;
  }, [showRulerGrid, currentStepIndex, meshesReady]);

  // Update part visibility and materials when step changes (instant - no re-parsing)
  useEffect(() => {
    if (currentStepIndex === undefined || meshesRef.current.length === 0 || !meshesReady) return;
    
    const stepBoundaries = stepBoundariesRef.current;
    const visibleCount = stepBoundaries[currentStepIndex] ?? meshesRef.current.length;
    const prevStepEnd = currentStepIndex > 0 ? (stepBoundaries[currentStepIndex - 1] ?? 0) : 0;
    
    // Create grey material if not exists
    if (!greyMaterialRef.current) {
      greyMaterialRef.current = new THREE.MeshStandardMaterial({
        color: 0x888888,
        transparent: true,
        opacity: 0.7
      });
    }
    const greyMaterial = greyMaterialRef.current;
    
    // Toggle room + baseplate visibility together
    const { scene } = sceneRef.current;
    if (scene) {
      const displayRoom = scene.getObjectByName('display-room');
      const baseplate = scene.getObjectByName('baseplate');
      const rulerGrid = scene.getObjectByName('ruler-grid');
      // Show room only when at least one part is visible (model is being displayed)
      const anyPartVisible = visibleCount > 0;
      if (displayRoom) displayRoom.visible = anyPartVisible;
      if (baseplate) baseplate.visible = anyPartVisible;
      if (rulerGrid) rulerGrid.visible = showRulerGrid && anyPartVisible;
    }

    meshesRef.current.forEach((part, idx) => {
      // Hide parts beyond current step
      if (idx >= visibleCount) {
        part.visible = false;
        return;
      }
      
      part.visible = true;
      
      // Check if this part is in the current step (not a previous step)
      const isCurrentStep = idx >= prevStepEnd && idx < visibleCount;
      
      // Apply materials
      part.traverse((child) => {
        if (child.type === 'Mesh') {
          const mesh = child as THREE.Mesh;
          
          // Store original material if not stored
          if (!originalMaterialsRef.current.has(part)) {
            originalMaterialsRef.current.set(part, new Map());
          }
          const partMaterials = originalMaterialsRef.current.get(part)!;
          if (!partMaterials.has(mesh)) {
            partMaterials.set(mesh, mesh.material);
          }
          
          // If highlightNewParts is disabled, always show original colors
          if (!highlightNewParts) {
            const original = partMaterials.get(mesh);
            if (original) {
              mesh.material = original;
            }
          } else if (isCurrentStep) {
            // Restore original material for current step
            const original = partMaterials.get(mesh);
            if (original) {
              mesh.material = original;
            }
          } else {
            // Apply grey transparent material for previous steps
            mesh.material = greyMaterial;
          }
        }
      });
    });
  }, [currentStepIndex, meshesReady, highlightNewParts, showRulerGrid]);

  // Always render without Card wrapper (simplified embedded mode)
  return (
    <div className={`relative w-full h-full ${className}`}>
      {error ? (
        <div className="flex items-center justify-center h-full text-red-500 text-sm">
          {error}
        </div>
      ) : (
        <>
          {loading && (
            <div className="absolute inset-0 bg-white bg-opacity-90 flex items-center justify-center z-10">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-[3px] border-gray-300 border-t-black rounded-full animate-spin"></div>
              </div>
            </div>
          )}
          <div 
            ref={containerRef} 
            className="w-full h-full bg-gray-100 rounded-lg overflow-hidden"
            style={{ visibility: loading ? 'hidden' : 'visible' }}
          />
          <button
            type="button"
            onClick={() => setShowRulerGrid((visible) => !visible)}
            disabled={loading || !!error}
            className="absolute left-3 top-3 z-20 inline-flex items-center gap-2 rounded-full border border-slate-700/30 bg-slate-950/85 px-2.5 py-2 text-xs font-semibold text-white shadow-lg shadow-black/25 backdrop-blur-sm transition-all duration-150 hover:bg-slate-800 hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-60 sm:px-4"
            title={showRulerGrid ? 'Hide ruler' : 'Show ruler'}
            aria-label={showRulerGrid ? 'Hide ruler' : 'Show ruler'}
            aria-pressed={showRulerGrid}
          >
            <Ruler size={14} />
            <span className="hidden sm:inline">{showRulerGrid ? 'Hide ruler' : 'Show ruler'}</span>
          </button>
          {canExplodeModel && (
            <button
              type="button"
              onClick={handleToggleExplode}
              disabled={explodeMode === 'rebuilding'}
              className="absolute bottom-3 left-3 z-20 inline-flex items-center gap-2 rounded-full border border-slate-700/30 bg-slate-950/85 px-2.5 py-2 text-xs font-semibold text-white shadow-lg shadow-black/25 backdrop-blur-sm transition-all duration-150 hover:bg-slate-800 hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-60 sm:px-4"
              title={explodeMode === 'assembled' ? 'Explode model' : 'Rebuild model'}
              aria-label={explodeMode === 'assembled' ? 'Explode model' : 'Rebuild model'}
            >
              {explodeMode === 'exploded' || explodeMode === 'exploding' || explodeMode === 'rebuilding' ? (
                <RotateCcw size={14} />
              ) : (
                <span className="text-sm leading-none" aria-hidden="true">🤯</span>
              )}
              <span className="hidden sm:inline">
                {explodeMode === 'exploding'
                  ? 'Rebuild'
                  : explodeMode === 'rebuilding'
                    ? 'Rebuilding...'
                    : explodeMode === 'exploded'
                      ? 'Rebuild'
                      : 'Explode'}
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}
