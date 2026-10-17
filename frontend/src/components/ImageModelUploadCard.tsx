import React, { useEffect, useRef, useState } from 'react';
import { Box, Download, Loader2, Upload } from 'lucide-react';
import { Link } from 'react-router-dom';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { ModelMeshPreview } from './ModelMeshPreview';
import { IMAGE_UPLOAD_ACCEPT, prepareImageUpload } from '../utils/prepareImageUpload';
import { downloadImageModel, startImageModel, waitForImageModel } from '../services/imageToModel';
import type { ImageModelOutput } from '../imageModelPages';

export function ImageModelUploadCard({ output }: { output: ImageModelOutput }) {
  const { session } = useAuth();
  const picker = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const selection = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [model, setModel] = useState<File | null>(null);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const attribution = { page: `/image-to-${output}`, input_type: 'image', output_format: output };
  const track = (event: string, extra: Record<string, unknown> = {}) => posthog.capture(event, { ...attribution, ...extra });

  useEffect(() => () => { controller.current?.abort(); selection.current++; }, []);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    if (!model) { setModelUrl(null); return; }
    const url = URL.createObjectURL(model); setModelUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [model]);
  useEffect(() => () => { if (objUrl) URL.revokeObjectURL(objUrl); }, [objUrl]);

  async function selectFile(selected?: File) {
    if (!selected) return;
    const version = ++selection.current;
    setBusy(true); setError(''); setStatus('Preparing your image…');
    setFile(null); setModel(null); setObjUrl(null); setGenerationId(null);
    try {
      const prepared = await prepareImageUpload(selected);
      if (version !== selection.current) return;
      setFile(prepared);
      track('image_model_file_selected', { file_size_bytes: prepared.size });
    } catch (cause) {
      if (version !== selection.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not prepare this image.');
      track('image_model_file_rejected');
    } finally {
      if (version === selection.current) { setBusy(false); setStatus(''); }
    }
  }

  async function generate() {
    if (!file || busy) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(''); setStatus(generationId ? 'Loading your existing generation…' : 'Starting your 3D model…');
    try {
      const id = generationId ?? await startImageModel(file, session?.access_token);
      abort.signal.throwIfAborted();
      setGenerationId(id);
      if (!generationId) track('generation_started', { generation_id: id });
      const url = await waitForImageModel(id, abort.signal, result => setStatus(`Creating your model: ${result.status}…`));
      setStatus('Preparing your download…');
      const downloaded = await downloadImageModel(url, abort.signal);
      abort.signal.throwIfAborted();
      setModel(downloaded);
      track('image_model_generation_completed', { generation_id: id });
    } catch (cause) {
      if (abort.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Model generation failed. Please try again.');
      track('image_model_generation_failed');
    } finally {
      if (!abort.signal.aborted) { setBusy(false); setStatus(''); }
    }
  }

  async function exportObj() {
    if (!model || exporting) return;
    setExporting(true); setError('');
    track('image_model_obj_export_started');
    try {
      const { convertModelFormat } = await import('../services/modelFormatConversion');
      const converted = await convertModelFormat(model, 'glb');
      if (controller.current?.signal.aborted) return;
      setObjUrl(URL.createObjectURL(converted.blob));
      track('image_model_obj_export_completed');
    } catch (cause) {
      if (controller.current?.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'OBJ export failed. You can still download the GLB.');
      track('image_model_obj_export_failed');
    } finally {
      if (!controller.current?.signal.aborted) setExporting(false);
    }
  }

  const downloadClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#f44336] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#e53935] disabled:opacity-50';
  return <section aria-label="Image to 3D model upload" className="mt-6 w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-5 text-left sm:p-6">
    <h2 className="flex items-center gap-2 text-lg font-semibold"><Box className="h-5 w-5 text-[#f44336]" />Create your 3D model</h2>
    <p className="mt-2 text-sm leading-6 text-slate-500">Start with one clear image. Generation uses your existing credits or guest allowance and can take several minutes.</p>
    <input ref={picker} type="file" accept={IMAGE_UPLOAD_ACCEPT} aria-label="Choose source image" disabled={busy || exporting} className="hidden"
      onChange={event => { void selectFile(event.target.files?.[0]); event.target.value = ''; }} />
    {preview && <img src={preview} alt="Your source image for 3D generation" className="mx-auto mt-5 max-h-48 max-w-full rounded-lg object-contain" />}
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy || exporting} onClick={() => { track('image_model_upload_picker_opened'); picker.current?.click(); }}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"><Upload className="h-4 w-4" />{file ? 'Change image' : 'Choose image'}</button>
      {file && <span className="min-w-0 max-w-full break-all text-sm text-slate-500">{file.name}</span>}
    </div>
    <p className="mt-3 text-xs leading-5 text-slate-500">JPG, PNG, WebP, GIF, HEIC, HEIF, TIFF · up to 50 MB</p>
    {file && !model && <button type="button" disabled={busy} onClick={() => void generate()} className={`${downloadClass} mt-5`}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Box className="h-4 w-4" />}{busy ? 'Processing…' : generationId ? 'Load existing result' : 'Generate 3D model'}</button>}
    <div role="status" aria-live="polite" aria-busy={busy}>{status && <p className="mt-3 text-sm text-slate-500">{status}</p>}</div>
    {modelUrl && <div className="mt-6 space-y-4">
      <ModelMeshPreview objectUrl={modelUrl} format="glb" />
      <p className="text-sm font-semibold text-emerald-700">Your 3D model is ready. Drag the preview to rotate it.</p>
      <div className="flex flex-wrap gap-3">
        <a href={modelUrl} download="image-model.glb" onClick={() => track('image_model_download_clicked', { download_format: 'glb' })} className={downloadClass}><Download className="h-4 w-4" />Download GLB</a>
        {objUrl ? <a href={objUrl} download="image-model.obj" onClick={() => track('image_model_download_clicked', { download_format: 'obj' })} className={downloadClass}><Download className="h-4 w-4" />Download OBJ</a>
          : <button type="button" disabled={exporting} onClick={() => void exportObj()} className={downloadClass}>{exporting && <Loader2 className="h-4 w-4 animate-spin" />}{exporting ? 'Exporting OBJ…' : 'Export OBJ'}</button>}
      </div>
      <p className="text-xs leading-5 text-slate-500">GLB includes the generated appearance. OBJ exports geometry without textures or an MTL file.</p>
    </div>}
    {error && <p role="alert" className="mt-4 text-sm leading-6 text-red-600">{error}</p>}
    {generationId && <Link to={`/generated-model?id=${encodeURIComponent(generationId)}`} onClick={() => track('image_model_brick_result_clicked', { generation_id: generationId })} className="mt-5 inline-block text-sm font-semibold text-[#c42d23] underline">Open this generation’s brick version</Link>}
  </section>;
}
