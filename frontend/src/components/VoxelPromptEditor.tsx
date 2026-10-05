import React from 'react';
import { Loader2, Wand2 } from 'lucide-react';

interface Props {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  loading: boolean;
  disabled: boolean;
  error: string | null;
  manualEditControl?: React.ReactNode;
}

export function VoxelPromptEditor({ prompt, onPromptChange, onSubmit, loading, disabled, error, manualEditControl }: Props) {
  return (
    <form className="model-refine-card"
      onSubmit={(event) => { event.preventDefault(); if (prompt.trim() && !loading && !disabled) onSubmit(); }}>
      <label htmlFor="voxel-edit-prompt" className="block text-lg font-semibold text-slate-900">Refine your model</label>
      <p id="voxel-edit-help" className="mt-1 text-sm text-slate-500">Tell us what you'd like to change.</p>
      <textarea id="voxel-edit-prompt" aria-describedby="voxel-edit-help" maxLength={2000} rows={3}
        value={prompt} onChange={(event) => onPromptChange(event.target.value)} disabled={loading || disabled}
        placeholder="e.g. Make the roof red and add a chimney…"
        className="mt-3 block w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-base text-slate-900 focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100 disabled:opacity-60" />
      <div className="mt-3 flex items-center gap-2 sm:gap-3">
        <button type="submit" disabled={loading || disabled || !prompt.trim()}
          className="inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50">
          {loading ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <Wand2 size={16} className="shrink-0" />}
          {loading ? 'Editing model…' : 'Apply Edit'}
        </button>
        {manualEditControl && <div className="model-manual-edit shrink-0">{manualEditControl}</div>}
      </div>
      {loading && <p role="status" className="mt-2 text-sm text-slate-500">Updating your model. This can take a few minutes.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </form>
  );
}
