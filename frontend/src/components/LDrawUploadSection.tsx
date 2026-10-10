import React, { useEffect, useRef, useState } from 'react';
import { Box, Upload } from 'lucide-react';
import posthog from 'posthog-js';
import { LDRAW_UPLOAD_ACCEPT, UploadLdrawApiService } from '../services/uploadLdrawApi';

export function LDrawUploadSection({ authToken, onImported }: { authToken?: string; onImported: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const upload = async (file: File, source: 'picker' | 'drop') => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setUploading(true); setError(null);
    posthog.capture('ldraw_upload_started', { source, format: file.name.split('.').pop()?.toLowerCase() });
    try {
      const result = await UploadLdrawApiService.upload(file, authToken, current.signal);
      if (current.signal.aborted) return;
      posthog.capture('ldraw_upload_completed', { generation_id: result.generation_id });
      onImported(result.generation_id);
    } catch (failure) {
      if (!current.signal.aborted) {
        setError(failure instanceof Error ? failure.message : 'Unable to import this model. Please try again.');
        posthog.capture('ldraw_upload_failed');
      }
    } finally {
      if (controller.current === current) { controller.current = null; setUploading(false); }
    }
  };
  return <section aria-label="Upload LDraw model" className="w-full text-left" onDragEnter={event => { event.preventDefault(); event.stopPropagation(); setDragging(true); }}
    onDragOver={event => { event.preventDefault(); event.stopPropagation(); }}
    onDragLeave={event => { event.preventDefault(); event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void upload(file, 'drop'); }}>
    <button type="button" disabled={uploading} aria-label="Choose LDraw file" onClick={() => { posthog.capture('ldraw_upload_picker_opened'); input.current?.click(); }}
      className={`flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed bg-white px-6 py-8 text-center shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-wait ${dragging ? 'border-[#f44336] bg-red-50' : 'border-red-200 hover:border-[#f44336]'}`}>
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-[#f44336]"><Box aria-hidden="true" className="h-8 w-8" /></span>
      <span className="text-xl font-semibold text-slate-900">{uploading ? 'Importing your model…' : 'Drag and drop your LDraw model here'}</span>
      <span className="inline-flex items-center gap-2 rounded-full bg-[#f44336] px-5 py-2.5 text-sm font-semibold text-white"><Upload aria-hidden="true" className="h-4 w-4" />Choose model</span>
      <span className="text-xs text-slate-500">Studio .io, LDraw .ldr and .mpd · up to 16 MB</span>
    </button>
    <input ref={input} type="file" aria-label="LDraw file" accept={LDRAW_UPLOAD_ACCEPT} className="hidden" disabled={uploading}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file, 'picker'); }} />
    <p className="mt-3 text-sm leading-6 text-slate-600">Upload your model to preview it and edit with AI. Ordering becomes available after an AI edit replaces unsupported parts and validates the model against Brickwith’s available parts and colors.</p>
    {uploading && <p role="status" className="mt-2 text-sm text-slate-500">Importing your model…</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
  </section>;
}
