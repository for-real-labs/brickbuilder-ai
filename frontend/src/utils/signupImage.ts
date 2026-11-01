/** Preserve an uploaded image through a Google or email-link signup redirect. */
export async function saveSignupImage(key: string, file: File): Promise<void> {
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Unable to save your image.'));
    reader.readAsDataURL(file);
  });
  // A storage/quota failure must stop the redirect, so the image is not lost.
  sessionStorage.setItem(key, JSON.stringify({ name: file.name, type: file.type, base64 }));
}

export function restoreSignupImage(key: string): File | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  sessionStorage.removeItem(key);
  try {
    const { name, type, base64 } = JSON.parse(raw);
    if (typeof name !== 'string' || typeof type !== 'string' || typeof base64 !== 'string') return null;
    return new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], name, { type });
  } catch { return null; }
}
