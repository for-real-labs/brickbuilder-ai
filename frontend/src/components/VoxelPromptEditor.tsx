import React, { useRef } from 'react';
import { Loader2, Wand2 } from 'lucide-react';

interface Props {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  loading: boolean;
  disabled: boolean;
  error: string | null;
  manualEditControl?: React.ReactNode;
  onSuggestionSelected?: (suggestion: string) => void;
}

const suggestions = [
  { label: 'Change colors', prompt: 'Use a brighter, more vibrant color palette.', id: 'colors' },
  { label: 'Add detail', prompt: 'Add more detail while keeping the same overall shape.', id: 'detail' },
  { label: 'Simplify', prompt: 'Simplify the shape while keeping the model recognizable.', id: 'simplify' },
];

export function VoxelPromptEditor({ prompt, onPromptChange, onSubmit, loading, disabled, error, manualEditControl, onSuggestionSelected }: Props) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  return (
    <form className="model-refine-card"
      onSubmit={(event) => { event.preventDefault(); if (prompt.trim() && !loading && !disabled) onSubmit(); }}>
      <label htmlFor="voxel-edit-prompt" className="block text-lg font-semibold text-slate-900">Refine your model</label>
      <p id="voxel-edit-help" className="mt-1 text-sm text-slate-500">Tell us what you'd like to change.</p>
      <div className="model-edit-suggestions">
        {suggestions.map(suggestion => <button key={suggestion.id} type="button" disabled={loading || disabled}
          onClick={() => { onPromptChange(suggestion.prompt); onSuggestionSelected?.(suggestion.id); textarea.current?.focus(); }}>
          {suggestion.label}
        </button>)}
      </div>
      <textarea ref={textarea} id="voxel-edit-prompt" aria-describedby="voxel-edit-help" maxLength={2000} rows={3}
        value={prompt} onChange={(event) => onPromptChange(event.target.value)} disabled={loading || disabled}
        placeholder="e.g. Make the roof red and add a chimney…"
        className="block w-full resize-y rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-base text-slate-900 focus:border-red-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-red-100 disabled:opacity-60" />
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
