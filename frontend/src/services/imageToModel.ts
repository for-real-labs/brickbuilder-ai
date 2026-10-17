import { ImageToBricksApiService } from './imageToBricksApi';
import { GetGenerationApiService, type GetGenerationResponse } from './getGenerationApi';
import { recordAnonymousGeneration } from '../utils/anonGenerations';

const MAX_MODEL_BYTES = 50 * 1024 * 1024;

export async function startImageModel(file: File, token?: string): Promise<string> {
  const image = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read this image.'));
    reader.onerror = () => reject(new Error('Could not read this image.'));
    reader.readAsDataURL(file);
  });
  // Preserve the source image instead of applying LEGO-style preprocessing.
  const result = await ImageToBricksApiService.generateBricksFromImage(image, 1.6, token, 'b', 'a', undefined, false);
  if (!token) recordAnonymousGeneration(result.generation_id);
  return result.generation_id;
}

export async function waitForImageModel(id: string, signal: AbortSignal,
                                       onStatus: (result: GetGenerationResponse) => void): Promise<string> {
  const result = await GetGenerationApiService.pollUntilComplete(id, onStatus, 2500, 360, signal);
  if (!result.glb_url) throw new Error('This generation has no downloadable 3D mesh. Open the brick version to inspect its result.');
  const url = new URL(result.glb_url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('The model download URL is invalid.');
  return url.href;
}

export async function downloadImageModel(url: string, signal: AbortSignal): Promise<File> {
  // Model storage is separate from the API: never forward account or guest credentials.
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok || !response.body) throw new Error('Could not download the generated model. Try loading the result again.');
  if (Number(response.headers.get('Content-Length')) > MAX_MODEL_BYTES) throw new Error('The generated model exceeds the 50 MB download limit.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MODEL_BYTES) throw new Error('The generated model exceeds the 50 MB download limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!size) throw new Error('The generated model file is empty.');
  return new File(chunks, 'image-model.glb', { type: 'model/gltf-binary' });
}
