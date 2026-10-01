import React from 'react';
import { Loader2, Pencil } from 'lucide-react';

interface ModelEditControlsProps {
  isManualEditorOpen: boolean;
  manualLoading: boolean;
  onManualEdit: () => void;
}

export function ModelEditControls({
  isManualEditorOpen,
  manualLoading,
  onManualEdit,
}: ModelEditControlsProps) {
  if (isManualEditorOpen) {
    return (
      <div className="flex w-full justify-center sm:w-auto">
        <button
          type="button"
          aria-label="Exit block editor"
          onClick={onManualEdit}
          disabled={manualLoading}
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-[#f44336] bg-[#f44336] px-7 font-semibold text-white shadow-lg shadow-[#f44336]/25 transition-all duration-150 hover:scale-[1.03] hover:border-[#ff6b6b] hover:bg-[#ff6b6b] focus:outline-none focus:ring-2 focus:ring-[#f44336] focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto sm:min-w-44"
        >
          <Pencil size={16} />
          Exit Block Editor
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label="Manually edit model"
      onClick={onManualEdit}
      disabled={manualLoading}
      className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 transition-all duration-150 hover:scale-[1.03] hover:border-[#f44336] hover:text-[#f44336] hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-70 sm:w-auto sm:min-w-44 sm:px-7 sm:text-base"
    >
      {manualLoading ? (
        <>
          <Loader2 size={16} className="animate-spin" />
          Loading...
        </>
      ) : (
        <>
          <Pencil size={16} className="hidden sm:block" />
          Manually Edit
        </>
      )}
    </button>
  );
}
