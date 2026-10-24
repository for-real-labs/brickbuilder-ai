import { useEffect, useState, type RefObject } from 'react';
import posthog from 'posthog-js';

/** Treat background scroll gestures as a small help reveal in the fixed landing shell. */
export function useLandingReveal(ref: RefObject<HTMLDivElement | null>, enabled: boolean, staged = false) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    setStage(0);
    const shell = ref.current;
    if (!enabled || !shell) return;
    let revealed = 0;
    let distance = 0;
    let touchStart: { x: number; y: number } | null = null;
    const update = (next: boolean, source: string, delta = 80) => {
      distance = staged ? Math.max(0, Math.min(360, distance + (next ? 1 : -1) * Math.min(Math.abs(delta), 180))) : next ? 360 : 0;
      const value = distance >= 260 ? 2 : distance >= 60 ? 1 : 0;
      if (revealed === value) return;
      if ((revealed === 2) !== (value === 2)) posthog.capture('landing_help_toggled', { expanded: value === 2, source });
      if (staged && (revealed > 0) !== (value > 0)) posthog.capture('landing_stats_toggled', { expanded: value > 0, source });
      revealed = value;
      setStage(value);
    };
    const reset = (source: string) => { distance = 0; update(false, source); };
    const canReveal = (target: EventTarget | null, delta: number) => {
      if (!(target instanceof Element) || !shell.contains(target)) return false;
      if (target.closest('header, a, button, input, textarea, select, [contenteditable="true"], dialog, .landing-model-workspace, .landing-model-toolbar')) return false;
      if (shell.contains(document.activeElement) && document.activeElement?.matches('input, textarea, [contenteditable="true"]')) return false;
      // Let conversation history and other nested scroll areas consume their own gestures.
      for (let element = target; element !== shell && element.parentElement; element = element.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(element).overflowY)) continue;
        if (delta > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1) return false;
        if (delta < 0 && element.scrollTop > 0) return false;
      }
      return true;
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < 4 || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !canReveal(event.target, event.deltaY)) return;
      event.preventDefault();
      update(event.deltaY > 0, 'scroll', event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 180 : 1));
    };
    const startTouch = (event: TouchEvent) => {
      touchStart = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null;
    };
    const moveTouch = (event: TouchEvent) => {
      if (!touchStart || event.touches.length !== 1) return;
      const delta = touchStart.y - event.touches[0].clientY;
      if (Math.abs(delta) < 32 || Math.abs(event.touches[0].clientX - touchStart.x) > Math.abs(delta) || !canReveal(event.target, delta)) return;
      event.preventDefault();
      update(delta > 0, 'swipe', delta);
      touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const endTouch = () => { touchStart = null; };
    const returnToDialogue = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.landing-model-conversation')) reset('dialogue');
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape') reset('keyboard');
      const target = event.target === document.body || event.target === document.documentElement ? shell : event.target;
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key) && canReveal(target, 1)) {
        event.preventDefault();
        update(true, 'keyboard', 180);
      }
    };
    shell.addEventListener('wheel', wheel, { passive: false });
    shell.addEventListener('touchstart', startTouch, { passive: true });
    shell.addEventListener('touchmove', moveTouch, { passive: false });
    shell.addEventListener('touchend', endTouch);
    shell.addEventListener('touchcancel', endTouch);
    shell.addEventListener('pointerdown', returnToDialogue, true);
    shell.addEventListener('focusin', returnToDialogue);
    window.addEventListener('keydown', keyDown);
    return () => {
      shell.removeEventListener('wheel', wheel);
      shell.removeEventListener('touchstart', startTouch);
      shell.removeEventListener('touchmove', moveTouch);
      shell.removeEventListener('touchend', endTouch);
      shell.removeEventListener('touchcancel', endTouch);
      shell.removeEventListener('pointerdown', returnToDialogue, true);
      shell.removeEventListener('focusin', returnToDialogue);
      window.removeEventListener('keydown', keyDown);
    };
  }, [enabled, ref, staged]);

  return enabled ? stage : 0;
}

export function useLandingHelp(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  return useLandingReveal(ref, enabled) === 2;
}
