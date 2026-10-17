import { getGeneratedModelPath } from '../utils/generationRoutes';
import React, { useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { ModelMeshPreview as MeshViewer } from './ModelMeshPreview';
import { useLocation, useNavigate } from 'react-router-dom';
import { Upload, Loader2, Box } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { GlbToBricksApiService, type MeshFormat } from '../services/glbToBricksApi';
import { GetGenerationApiService } from '../services/getGenerationApi';
import { NovaToBricksApiService } from '../services/novaToBricksApi';

/** Shared upload and conversion flow for the GLB and OBJ landing pages. */
export function GlbUploadCard({ autoOpen = false, format = 'glb' }: { autoOpen?: boolean; format?: MeshFormat } = {}) {
  const { session } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [mode, setMode] = useState<'voxel' | 'all_parts'>('voxel');
  const [source, setSource] = useState<'model' | 'image'>('model');
  const [detailLevel, setDetailLevel] = useState(40);
  const [voxelGenerationId, setVoxelGenerationId] = useState<string | null>(null);
  const label = format.toUpperCase();
  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Revoke the object URL when it changes/unmounts.
  useEffect(() => {
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl, format]);

  // Open the file browser automatically when requested (e.g. the parent's
  // "Upload glb" button was clicked).
  useEffect(() => {
    if (autoOpen) {
      posthog.capture(`${format}_upload_picker_opened`, { page: pathname, input_type: format, input_format: format });
      fileInputRef.current?.click();
    }
  }, [autoOpen, format, pathname]);

  const attribution = { page: pathname, input_type: format, input_format: format };
  const track = (event: string) => posthog.capture(`${format}_${event}`, attribution);
  const openPicker = () => { track('upload_picker_opened'); fileInputRef.current?.click(); };

  const handleSelectFile = (selected: File | null) => {
    if (!selected) return;
    if (!selected.name.toLowerCase().endsWith(`.${format}`)) {
      setError(`Please select a .${format} file`);
      return;
    }
    if (selected.size > 50 * 1024 * 1024 || selected.size === 0) {
      setError('Choose a nonempty model file up to 50 MB');
      return;
    }
    setError(null);
    setStatus(null);
    setVoxelGenerationId(null);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    track('file_selected');
    setFile(selected);
    setObjectUrl(URL.createObjectURL(selected));
  };

  const handleConvert = async () => {
    if (!file || submitting) return;
    setSubmitting(true);
    setError(null);
    setStatus('Uploading…');
    track('upload_started');
    try {
      const { generation_id } = await GlbToBricksApiService.uploadGlb(
        file,
        'trimesh',
        detailLevel,
        session?.access_token,
        format,
      );
      posthog.capture('generation_started', { ...attribution, generation_id });
      setStatus('Processing…');
      await GetGenerationApiService.pollUntilComplete(generation_id, (res) => {
        if (res.status) setStatus(`Status: ${res.status}`);
      });
      posthog.capture(`${format}_conversion_completed`, { ...attribution, generation_id });
      setVoxelGenerationId(generation_id);
      if (mode === 'all_parts') {
        setStatus('Designing with all LEGO parts…');
        const result = await NovaToBricksApiService.edit(generation_id,
          'Rebuild this voxelized reference using the full LEGO parts catalog. Preserve its silhouette, proportions and colors; use suitable slopes, curves, plates and bricks with valid connections.',
          session?.access_token);
        posthog.capture('generation_started', { ...attribution, generation_id: result.generation_id, mode: 'all_parts', source_generation_id: generation_id });
        navigate(getGeneratedModelPath(result.generation_id));
      } else {
        navigate(getGeneratedModelPath(generation_id));
      }
    } catch (err) {
      track('conversion_failed');
      console.error('Mesh conversion failed:', err);
      setError(err instanceof Error ? err.message : 'Conversion failed');
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white w-full p-5 sm:p-6 max-w-2xl mt-6 text-left">
      <h2 className="text-lg font-semibold text-slate-900 mb-1 flex items-center gap-2">
        <Box className="w-5 h-5 text-[#f44336]" />
        Choose your brick style
      </h2>
      <p className="text-sm text-slate-500 mb-5">
        Keep the voxel look, or redesign your model with the full LEGO parts catalog.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept={`.${format}`}
        aria-label={`Upload ${label} model`}
        disabled={submitting}
        className="hidden"
        onChange={(e) => handleSelectFile(e.target.files?.[0] || null)}
      />

      <div className="mb-5 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1" role="group" aria-label="Conversion mode">
        {(['voxel', 'all_parts'] as const).map(value => (
          <button key={value} type="button" disabled={submitting} aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              posthog.capture('model_converter_mode_selected', { ...attribution, mode: value });
            }}
            className={`min-h-12 rounded-lg px-3 py-2 text-sm font-semibold transition-colors disabled:opacity-50 ${mode === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-900'}`}>
            {value === 'voxel' ? 'Voxel mode' : 'All LEGO parts'}
          </button>
        ))}
      </div>
      {mode === 'all_parts' && <div className="mb-5">
        <p className="mb-2 text-sm font-medium text-slate-700">Start from</p>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Model source">
          {(['image', 'model'] as const).map(value => <button key={value} type="button" disabled={submitting}
            aria-pressed={source === value} onClick={() => {
              setSource(value);
              posthog.capture('model_converter_source_selected', { ...attribution, source: value });
            }}
            className={`min-h-11 rounded-lg border px-3 py-2 text-sm font-medium ${source === value ? 'border-red-300 bg-red-50 text-red-700' : 'border-slate-200 text-slate-600'}`}>
            From {value === 'image' ? 'image' : label}
          </button>)}
        </div>
      </div>}
      {mode === 'all_parts' && source === 'image' ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          <p className="mb-4">Upload a photo or image in our image-to-LEGO builder. All LEGO parts will be selected for you.</p>
          <button type="button" onClick={() => {
            posthog.capture('model_converter_image_started', { ...attribution, mode });
            navigate('/image-to-lego?mode=all_parts');
          }} className="min-h-11 rounded-lg bg-[#f44336] px-4 py-2 font-semibold text-white hover:bg-[#ff6b6b]">Continue with image</button>
        </div>
      ) : <>
      <p className="mb-4 text-sm text-slate-500">Upload a .{format} file up to 50 MB.{format === 'obj' && ' Standalone OBJ geometry and vertex colors are supported; external MTL files and textures are not included.'}</p>
      <label className="mb-5 block text-sm font-medium text-slate-700">
        Model size <span className="float-right text-slate-500">{detailLevel}</span>
        <input type="range" min="10" max="60" step="1" value={detailLevel} disabled={submitting}
          aria-label="Model size" className="mt-3 w-full accent-[#f44336]"
          onChange={event => setDetailLevel(Number(event.target.value))}
          onPointerUp={() => posthog.capture('model_converter_size_changed', { ...attribution, detail_level: detailLevel })}
          onKeyUp={() => posthog.capture('model_converter_size_changed', { ...attribution, detail_level: detailLevel })} />
        <span className="mt-1 flex justify-between text-xs font-normal text-slate-500"><span>Smaller · fewer bricks</span><span>Larger · more detail</span></span>
      </label>
      {!objectUrl ? (
        <button
          type="button"
          onClick={openPicker}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer"
        >
          <Upload className="w-4 h-4" />
          Choose {label} file
        </button>
      ) : (
        <div className="space-y-4">
          <MeshViewer objectUrl={objectUrl} format={format} />

          <div className="flex items-center justify-between">
            <span className="text-sm text-slate-600 truncate max-w-[60%]">{file?.name}</span>
            <button
              type="button"
              onClick={openPicker}
              disabled={submitting}
              className="text-sm font-medium text-[#f44336] hover:text-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50"
            >
              Change file
            </button>
          </div>

          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleConvert}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-[#f44336] rounded-lg hover:bg-[#ff6b6b] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Box className="w-4 h-4" />}
              Convert to bricks
            </button>
            {status && <span className="text-sm text-slate-500">{status}</span>}
          </div>
        </div>
      )}

      </>}

      {error && voxelGenerationId && <button type="button" className="mt-3 text-sm text-[#f44336] underline" onClick={() => {
        posthog.capture('model_converter_voxel_fallback_opened', { ...attribution, generation_id: voxelGenerationId });
        navigate(getGeneratedModelPath(voxelGenerationId));
      }}>Open voxel version</button>}
      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
    </div>
  );
}

export default GlbUploadCard;
