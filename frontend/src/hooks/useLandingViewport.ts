import { useEffect, useRef } from 'react';

/** Keeps the landing shell inside the visible viewport, including above a mobile keyboard. */
export function useLandingViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      element.style.setProperty('--landing-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
      element.style.setProperty('--landing-viewport-top', `${viewport?.offsetTop ?? 0}px`);
    };
    const header = element.querySelector('header');
    const conversation = element.querySelector('.landing-model-conversation');
    const updatePanels = () => {
      element.style.setProperty('--landing-header-height', `${header?.getBoundingClientRect().height ?? 36}px`);
      element.style.setProperty('--landing-conversation-height', `${conversation?.getBoundingClientRect().height ?? 0}px`);
    };
    updateViewport();
    updatePanels();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePanels);
    if (header) observer?.observe(header);
    if (conversation) observer?.observe(conversation);
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    return () => {
      observer?.disconnect();
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
    };
  }, [enabled]);

  return ref;
}
