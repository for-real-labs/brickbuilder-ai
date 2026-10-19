import React, { lazy, Suspense, useEffect, useState } from 'react';

const ThreeLDRViewer = lazy(() => import('./ThreeLDRViewer').then(module => ({ default: module.ThreeLDRViewer })));
export const LDRAW_GENERATION_SCENES = ['house', 'tree', 'rocket', 'race-car', 'flower'] as const;
const CYCLE_MS = 8_000;

/** Packed LDraw scenes made only from part/color combinations in the Brickwith catalog. */
export function LdrawGenerationAnimation() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * LDRAW_GENERATION_SCENES.length));
  const [reducedMotion, setReducedMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setInterval(() => setIndex(current => {
      const next = Math.floor(Math.random() * (LDRAW_GENERATION_SCENES.length - 1));
      return next >= current ? next + 1 : next;
    }), CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [reducedMotion]);
  const scene = LDRAW_GENERATION_SCENES[index];
  return <div className="ldraw-generation-animation" role="img" aria-label="3D brick model assembling">
    <Suspense fallback={null}>
      <ThreeLDRViewer key={scene} modelPath={`/assets/ldraw-generation-scenes/${scene}.mpd`}
        autoRotate={false} showExplodeControl={false} showModelControls={false}
        presentation="model" animateModelBuild={!reducedMotion} buildAnimationStyle="fade" />
    </Suspense>
  </div>;
}
