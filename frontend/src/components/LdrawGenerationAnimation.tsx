import React, { lazy, Suspense, useEffect, useState } from 'react';

const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));
export const LDRAW_GENERATION_SCENES = ['house', 'tree', 'rocket', 'race-car', 'flower'] as const;

/** Packed LDraw scenes made only from part/color combinations in the Brickwith catalog. */
export function LdrawGenerationAnimation() {
  const [index] = useState(() => Math.floor(Math.random() * LDRAW_GENERATION_SCENES.length));
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);
  const scene = LDRAW_GENERATION_SCENES[index];
  return <div className="ldraw-generation-animation" role="img" aria-label="Bricks falling onto a table">
    <Suspense fallback={null}>
      <ThreeLDRViewer key={scene} modelPath={`/assets/ldraw-generation-scenes/${scene}.mpd`}
        autoRotate={!reducedMotion} interactionEnabled={false} generationDrops={!reducedMotion} showExplodeControl={false} showModelControls={false}
        presentation="room" />
    </Suspense>
  </div>;
}
