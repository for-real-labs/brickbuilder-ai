import { apiFetch } from './apiFetch';
import type { MeshFormat } from '../voxelConverters';
import type { VoxelFormat } from '../voxelConverters';

const mode = import.meta.env.VITE_API_MODE || 'local';
const baseUrl = mode === 'railway'
  ? import.meta.env.VITE_RAILWAY_API_URL || 'https://brickai-backend-production.up.railway.app'
  : mode === 'railway_staging'
    ? import.meta.env.VITE_RAILWAY_API_URL_STAGING || 'https://brickai-backend-staging.up.railway.app'
    : import.meta.env.VITE_LOCAL_API_URL || 'http://127.0.0.1:8002';

export async function convertMeshToVoxels(file: File, input: MeshFormat, output: VoxelFormat,
                                         resolution: number, token?: string): Promise<Blob> {
  const body = new FormData();
  body.append('file', file);
  body.append('input_format', input);
  body.append('output_format', output);
  body.append('resolution', String(resolution));
  const response = await apiFetch(`${baseUrl}/meshToVoxels`, {
    method: 'POST', body, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let message = 'Conversion failed. Please try again.';
    try {
      const error = await response.json();
      if (typeof error.detail === 'string') message = error.detail;
    } catch { /* Keep a useful message for a proxy or network error response. */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('The converter returned an empty file. Please try again.');
  return blob;
}
