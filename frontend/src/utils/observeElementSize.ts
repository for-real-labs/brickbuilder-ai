/** Track layout changes as well as window resizing, ignoring hidden containers. */
export function observeElementSize(element: HTMLElement, onSize: (width: number, height: number) => void): () => void {
  const update = () => {
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (width > 0 && height > 0) onSize(width, height);
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
  observer?.observe(element);
  window.addEventListener('resize', update);
  update();
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', update);
  };
}
