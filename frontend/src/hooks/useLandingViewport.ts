import { useEffect, useRef } from 'react';

/** Keeps the landing shell inside the visible viewport, including above a mobile keyboard. */
export function useLandingViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const top = viewport?.offsetTop ?? 0;
      const banner = document.querySelector('[data-app-banner]');
      const bannerHeight = Math.max(0, (banner?.getBoundingClientRect().bottom ?? 0) - top);
      element.style.setProperty('--landing-viewport-height', `${Math.max(0, (viewport?.height ?? window.innerHeight) - bannerHeight)}px`);
      element.style.setProperty('--landing-viewport-top', `${top + bannerHeight}px`);
    };
    const header = element.querySelector('header');
    const intro = element.querySelector('.landing-page-intro');
    const conversation = element.querySelector<HTMLElement>('.landing-model-conversation');
    const updatePanels = () => {
      element.style.setProperty('--landing-header-height', `${header?.getBoundingClientRect().height ?? 36}px`);
      element.style.setProperty('--landing-conversation-height', `${conversation?.getBoundingClientRect().height ?? 0}px`);
      element.style.setProperty('--landing-intro-bottom', `${Math.max(0, (intro?.getBoundingClientRect().bottom ?? 0) - element.getBoundingClientRect().top)}px`);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      updateViewport();
      updatePanels();
    });
    updateViewport();
    updatePanels();
    observer?.observe(document.body);
    if (header) observer?.observe(header);
    if (intro) observer?.observe(intro);
    if (conversation) observer?.observe(conversation);
    const mutations = new MutationObserver(updatePanels);
    mutations.observe(element, { childList: true, subtree: true });
    viewport?.addEventListener('resize', updateViewport);
    viewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    window.addEventListener('scroll', updatePanels, { passive: true });
    return () => {
      observer?.disconnect();
      mutations.disconnect();
      viewport?.removeEventListener('resize', updateViewport);
      viewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('scroll', updatePanels);
    };
  }, [enabled]);

  return ref;
}
