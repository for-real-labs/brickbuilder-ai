import React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Download, Loader2, Upload } from 'lucide-react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { ModelMeshPreview } from './ModelMeshPreview';
import { convertMeshToVoxels } from '../services/meshToVoxelsApi';
import type { MeshFormat } from '../voxelConverters';
import { VOXEL_FORMATS, type VoxelFormat } from '../voxelConverters';

export function VoxelUploadCard({ input, output }: { input: MeshFormat; output: VoxelFormat }) {
  const { session } = useAuth();
  const { pathname } = useLocation();
  const picker = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [resolution, setResolution] = useState(40);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attribution = { page: pathname, input_type: input, input_format: input, output_format: output };
  const track = (event: string, properties = {}) => posthog.capture(`voxel_converter_${event}`, { ...attribution, ...properties });
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  useEffect(() => () => { if (downloadUrl) URL.revokeObjectURL(downloadUrl); }, [downloadUrl]);

  const selectFile = (selected?: File) => {
    if (!selected) return;
    setDownloadUrl(null);
    setFile(null);
    setPreviewUrl(null);
    if (!selected.name.toLowerCase().endsWith(`.${input}`)) {
      setError(`Please select a .${input} file`); track('file_rejected', { reason: 'format' }); return;
    }
    if (!selected.size || selected.size > 50 * 1024 * 1024) {
      setError('Choose a nonempty model file up to 50 MB'); track('file_rejected', { reason: 'size' }); return;
    }
    setError(null); setFile(selected); setPreviewUrl(URL.createObjectURL(selected)); track('file_selected');
  };
  const convert = async () => {
    if (!file || busy) return;
    setBusy(true); setError(null); setDownloadUrl(null); track('started', { resolution });
    try {
      const result = await convertMeshToVoxels(file, input, output, resolution, session?.access_token);
      setDownloadUrl(URL.createObjectURL(result)); track('completed', { resolution });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Conversion failed. Please try again.'); track('failed');
    } finally { setBusy(false); }
  };
  const downloadName = `${file?.name.replace(/\.[^.]+$/, '') || 'model'}.${output}`;
  return <section aria-label={`${input.toUpperCase()} to ${VOXEL_FORMATS[output].name} upload`} className="mt-6 w-full rounded-xl border border-slate-200 bg-white p-5 text-left shadow-sm sm:p-6">
    <h2 className="text-lg font-semibold">Upload your {input.toUpperCase()} model</h2>
    <p className="mt-1 text-sm leading-6 text-slate-500">Up to 50 MB · Surface voxelization · Direct .{output} download</p>
    <input ref={picker} type="file" accept={`.${input}`} aria-label={`Upload ${input.toUpperCase()} model`} disabled={busy} className="hidden"
      onChange={event => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />
    <button type="button" disabled={busy} onClick={() => { track('picker_opened'); picker.current?.click(); }}
      className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm font-semibold hover:border-[#f44336] hover:bg-red-50 disabled:opacity-50">
      <Upload className="h-5 w-5 shrink-0" />Choose {input.toUpperCase()} file
    </button>
    {file && <p className="mt-3 break-all text-sm text-slate-600">{file.name}</p>}
    {previewUrl && <div className="mt-4"><p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Original mesh preview</p><ModelMeshPreview objectUrl={previewUrl} format={input} /></div>}
    <label className="mt-5 block text-sm font-semibold" htmlFor="voxel-resolution">Voxel resolution: {resolution}</label>
    <input id="voxel-resolution" type="range" min="8" max="64" step="1" value={resolution} disabled={busy}
      onChange={event => { setResolution(Number(event.target.value)); setDownloadUrl(null); }}
      onPointerUp={() => track('resolution_changed', { resolution })} onKeyUp={() => track('resolution_changed', { resolution })}
      className="mt-3 w-full accent-[#f44336]" />
    <p className="mt-1 text-xs leading-5 text-slate-500">Higher values add detail and increase processing time. Thin features may disappear at lower resolutions.</p>
    {output === 'binvox' && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">BINVOX stores occupied cells only. Choose VOX, QB, or XYZRGB to keep sampled colors.</p>}
    <button type="button" onClick={convert} disabled={!file || busy}
      className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#f44336] px-4 py-3 font-semibold text-white hover:bg-[#d9362b] disabled:cursor-not-allowed disabled:opacity-50">
      {busy ? <><Loader2 className="h-5 w-5 animate-spin" />Converting…</> : <>Convert to {VOXEL_FORMATS[output].name}</>}
    </button>
    <div aria-live="polite" role="status">{busy && <p className="mt-3 text-sm text-slate-500">Voxelizing your mesh. This can take up to 90 seconds.</p>}
      {downloadUrl && <a href={downloadUrl} download={downloadName} onClick={() => track('downloaded', { resolution })}
        className="mt-4 flex min-h-12 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 py-3 font-semibold text-white hover:bg-emerald-800"><Download className="h-5 w-5" />Download {VOXEL_FORMATS[output].name}</a>}
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
  </section>;
}
