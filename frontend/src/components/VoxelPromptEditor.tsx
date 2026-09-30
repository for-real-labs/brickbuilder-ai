import React from 'react';
import { Loader2, Wand2 } from 'lucide-react';

interface Props {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  loading: boolean;
  disabled: boolean;
  error: string | null;
}

export function VoxelPromptEditor({ prompt, onPromptChange, onSubmit, loading, disabled, error }: Props) {
  return (
    <form className="mx-auto my-6 w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      onSubmit={(event) => { event.preventDefault(); if (prompt.trim() && !loading && !disabled) onSubmit(); }}>
      <label htmlFor="voxel-edit-prompt" className="block text-base font-semibold text-slate-900">Edit with AI</label>
      <p id="voxel-edit-help" className="mt-1 text-sm text-slate-500">Describe what to change in your model. Each edit uses 1 credit.</p>
      <textarea id="voxel-edit-prompt" aria-describedby="voxel-edit-help" maxLength={2000} rows={3}
        value={prompt} onChange={(event) => onPromptChange(event.target.value)} disabled={loading || disabled}
        placeholder="Make the roof red and add a chimney…"
        className="mt-3 block w-full resize-y rounded-xl border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-100 disabled:opacity-60" />
      <button type="submit" disabled={loading || disabled || !prompt.trim()}
        className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-[#f44336] px-6 py-2 font-semibold text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
        {loading ? 'Editing model…' : 'Apply edit'}
      </button>
      {loading && <p role="status" className="mt-2 text-sm text-slate-500">Updating your model. This can take a few minutes.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </form>
  );
}
