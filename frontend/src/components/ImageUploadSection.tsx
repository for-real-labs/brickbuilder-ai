import React from 'react';
import { ImagePlus, Upload, X } from 'lucide-react';

export function ImageUploadSection({ previewUrl, fileName, busy, error, onPick, onRemove }: {
  previewUrl: string | null;
  fileName?: string;
  busy: boolean;
  error: string | null;
  onPick: () => void;
  onRemove: () => void;
}) {
  return <section aria-label="Image upload" className="mb-4 w-full text-left">
    <div className="relative rounded-2xl border-2 border-dashed border-red-200 bg-white shadow-sm transition-colors hover:border-[#f44336]">
      <button type="button" onClick={onPick} disabled={busy} aria-label={previewUrl ? 'Change uploaded image' : 'Select image from computer'}
        className="flex min-h-56 w-full flex-col items-center justify-center gap-3 rounded-2xl px-6 py-8 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-wait sm:min-h-64">
        {previewUrl ? <img src={previewUrl} alt="Uploaded preview" className="max-h-48 max-w-full rounded-xl object-contain" />
          : <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-[#f44336]"><ImagePlus aria-hidden="true" className="h-8 w-8" /></span>}
        <span className="max-w-full break-all text-xl font-semibold text-slate-900">{busy ? 'Preparing your image…' : previewUrl ? fileName : 'Drag and drop your image here'}</span>
        <span className="inline-flex items-center gap-2 rounded-full bg-[#f44336] px-5 py-2.5 text-sm font-semibold text-white"><Upload aria-hidden="true" className="h-4 w-4" />{previewUrl ? 'Choose another image' : 'Choose image'}</span>
        <span className="text-xs text-slate-500">JPG, PNG, WebP, GIF, HEIC, HEIF, TIFF and other image formats · up to 50 MB</span>
      </button>
      {previewUrl && <button type="button" onClick={onRemove} disabled={busy} aria-label="Remove image" className="absolute right-3 top-3 rounded-full border border-slate-200 bg-white p-2 text-slate-500 hover:text-red-500 focus-visible:ring-2 focus-visible:ring-red-300"><X aria-hidden="true" className="h-5 w-5" /></button>}
    </div>
    {busy && <p role="status" className="mt-2 text-sm text-slate-500">Preparing your image…</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
  </section>;
}
