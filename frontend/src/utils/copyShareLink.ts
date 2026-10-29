/** Keep the legacy selection inside the menu so mobile focus does not dismiss it. */
export async function copyShareLink(url: string, input: HTMLInputElement | null): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return;
    }
  } catch {
    // Safari and embedded browsers may deny the modern clipboard API.
  }

  if (input) {
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, input.value.length);
    if (document.execCommand?.('copy')) return;
  }
  throw new Error('Automatic copying is unavailable');
}
