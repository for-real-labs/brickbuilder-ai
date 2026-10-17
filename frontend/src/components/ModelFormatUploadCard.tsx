import React, { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, CheckCircle2, Download, Loader2, Upload } from 'lucide-react';
import posthog from 'posthog-js';
import { validateModelFile, type ConvertedModel, type ModelFormat } from '../services/modelFormatConversion';

export function ModelFormatUploadCard({ inputFormat }: { inputFormat: ModelFormat }) {
  const outputFormat = inputFormat === 'obj' ? 'glb' : 'obj';
  const attribution = { page: `/${inputFormat}-to-${outputFormat}`, input_format: inputFormat, output_format: outputFormat };
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ConvertedModel | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!result) { setDownloadUrl(null); return; }
    const url = URL.createObjectURL(result.blob);
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  function selectFile(selected: File | undefined) {
    setResult(null);
    setError('');
    setFile(null);
    if (!selected) return;
    try {
      validateModelFile(selected, inputFormat);
      setFile(selected);
      posthog.capture('model_format_file_selected', { ...attribution, file_size_bytes: selected.size });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that file.');
      posthog.capture('model_format_file_rejected', attribution);
    }
  }

  async function convert() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    setResult(null);
    posthog.capture('model_format_conversion_started', { ...attribution, file_size_bytes: file.size });
    try {
      // Load parsers/exporters only when a visitor uses the converter.
      const { convertModelFormat } = await import('../services/modelFormatConversion');
      const converted = await convertModelFormat(file, inputFormat);
      if (!mounted.current) return;
      setResult(converted);
      posthog.capture('model_format_conversion_completed', {
        ...attribution, output_size_bytes: converted.blob.size, triangle_count: converted.triangles,
      });
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : 'Conversion failed. Re-export the model and try again.');
      posthog.capture('model_format_conversion_failed', attribution);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return <div className="ph-no-capture mt-8 w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm sm:p-6">
    <div className="flex items-center gap-3">
      <span className="rounded-xl bg-red-50 p-3 text-[#f44336]"><ArrowRightLeft className="h-5 w-5" /></span>
      <div><h2 className="font-semibold">Convert {inputFormat.toUpperCase()} to {outputFormat.toUpperCase()}</h2>
        <p className="mt-1 text-sm text-slate-500">Free · No signup · Files stay in your browser</p></div>
    </div>
    <p className="mt-5 text-sm leading-6 text-slate-600">
      {inputFormat === 'obj'
        ? 'Upload a standalone OBJ mesh up to 50 MB. External MTL materials and texture files are not included.'
        : 'Upload a self-contained GLB up to 50 MB. Download a static OBJ mesh; materials, textures, and animations are not exported.'}
    </p>
    <input ref={picker} type="file" accept={`.${inputFormat}`} aria-label={`Choose ${inputFormat.toUpperCase()} file`} className="hidden" disabled={busy}
      onChange={event => { selectFile(event.target.files?.[0]); event.target.value = ''; }} />
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button type="button" disabled={busy} onClick={() => {
        posthog.capture('model_format_upload_picker_opened', attribution); picker.current?.click();
      }} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50">
        <Upload className="h-4 w-4" />{file ? 'Change file' : `Choose ${inputFormat.toUpperCase()} file`}
      </button>
      {file && <span className="min-w-0 max-w-full break-all text-sm text-slate-500">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</span>}
    </div>
    {file && <button type="button" disabled={busy} onClick={convert}
      className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#f44336] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#e53935] disabled:cursor-wait disabled:opacity-60">
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
      {busy ? 'Converting…' : `Convert to ${outputFormat.toUpperCase()}`}
    </button>}
    <div aria-live="polite" aria-busy={busy}>
      {busy && <p className="mt-3 text-sm text-slate-500">Processing your model locally. Large models may take a moment.</p>}
      {result && downloadUrl && <div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800"><CheckCircle2 className="h-4 w-4" />Your {outputFormat.toUpperCase()} file is ready</p>
        <p className="mt-2 text-sm text-emerald-800">{result.triangles.toLocaleString()} triangles · {(result.blob.size / 1024 / 1024).toFixed(2)} MB</p>
        <a href={downloadUrl} download={result.filename} onClick={() => posthog.capture('model_format_download_clicked', attribution)}
          className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800"><Download className="h-4 w-4" />Download {outputFormat.toUpperCase()}</a>
      </div>}
    </div>
    {error && <p role="alert" className="mt-4 text-sm leading-6 text-red-600">{error}</p>}
  </div>;
}
