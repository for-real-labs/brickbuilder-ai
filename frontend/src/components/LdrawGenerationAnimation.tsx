import React, { lazy, Suspense, useEffect, useState } from 'react';

const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));
export const LDRAW_GENERATION_SCENES = ['house', 'tree', 'rocket', 'race-car', 'flower'] as const;

/** Use a stable room footprint while the viewer loads random Brickwith catalog pieces. */
export function LdrawGenerationAnimation() {
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);
  const scene = LDRAW_GENERATION_SCENES[0];
  return <div className="ldraw-generation-animation" role="img" aria-label="Bricks falling onto a table">
    <Suspense fallback={null}>
      <ThreeLDRViewer key={scene} modelPath={`/assets/ldraw-generation-scenes/${scene}.mpd`}
        autoRotate={!reducedMotion} interactionEnabled={false} generationDrops={!reducedMotion} showExplodeControl={false} showModelControls={false}
        presentation="room" />
    </Suspense>
  </div>;
}
