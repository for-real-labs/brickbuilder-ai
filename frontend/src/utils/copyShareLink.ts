export function selectShareLink(input: HTMLInputElement) {
  input.focus({ preventScroll: true });
  input.select();
  input.setSelectionRange(0, input.value.length);
}

export async function copyShareLink(url: string, input: HTMLInputElement | null): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return;
    } catch {
      // Embedded browsers may deny the Clipboard API.
    }
  }

  if (input && typeof document.execCommand === 'function') {
    const previous = document.activeElement;
    let receivedCopyEvent = false;
    const writeSelectedLink = (event: ClipboardEvent) => {
      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', url);
        event.preventDefault();
      }
      receivedCopyEvent = true;
    };
    try {
      selectShareLink(input);
      document.addEventListener('copy', writeSelectedLink);
      if (document.execCommand('copy') && receivedCopyEvent) return;
    } catch {
      // Some browsers expose the command but disallow it.
    } finally {
      document.removeEventListener('copy', writeSelectedLink);
      if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
    }
  }

  throw new Error('Automatic copying is unavailable');
}
