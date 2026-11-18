import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, History, Package, X } from 'lucide-react';
import posthog from 'posthog-js';
import { GetGenerationsByImageApiService, type GenerationIteration } from '../services/getGenerationsByImageApi';

export function LandingPreviousEdits({ id, token, busy, onView }: {
  id: string; token?: string; busy: boolean; onView: (id: string) => void;
}) {
  const [edits, setEdits] = useState<GenerationIteration[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();

  useEffect(() => {
    let active = true;
    setEdits([]);
    void GetGenerationsByImageApiService.getGenerationsByImage(token, id).then(({ generations }) => {
      if (!active) return;
      setEdits([...generations].sort((a, b) => b.version - a.version || a.id.localeCompare(b.id)));
    }).catch(() => { /* A private or unavailable history should not affect the viewer. */ });
    return () => { active = false; };
  }, [id, token]);

  if (edits.length < 2) return null;

  return <>
    <button type="button" className="landing-action-button" disabled={busy} aria-haspopup="dialog"
      onClick={() => {
        dialog.current?.showModal();
        posthog.capture('landing_model_previous_edits_opened', { generation_id: id, edit_count: edits.length });
      }}><History size={16} aria-hidden="true" />Previous edits</button>
    <dialog ref={dialog} aria-labelledby={title}
      className="landing-previous-edits-dialog m-auto max-h-[85dvh] w-[min(36rem,calc(100%-1.5rem))] overflow-y-auto rounded-2xl bg-slate-50 shadow-xl backdrop:bg-slate-900/40">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 sm:px-5">
        <h2 id={title} className="text-lg font-semibold text-slate-900">Previous edits</h2>
        <button type="button" aria-label="Close previous edits" className="landing-action-button !px-3" onClick={() => dialog.current?.close()}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <ul className="space-y-2 p-3 sm:p-5">
        {edits.map(edit => {
          const current = edit.id === id;
          const image = edit.preview_image_url || edit.external_image_url || edit.thumbnail_url || edit.image_url || edit.processed_image_url;
          return <li key={edit.id}>
            <button type="button" className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm hover:border-red-200 focus-visible:outline-2 focus-visible:outline-red-500"
              aria-current={current ? 'true' : undefined} disabled={busy || edit.status !== 'completed'} onClick={() => {
                if (current) { dialog.current?.close(); return; }
                posthog.capture('landing_model_previous_edit_viewed', { generation_id: id, viewed_generation_id: edit.id, version: edit.version });
                dialog.current?.close();
                onView(edit.id);
              }}>
              <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100 text-slate-400">
                {image ? <img src={image} alt="" loading="lazy" className="h-full w-full object-contain" /> : <Package size={20} aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-slate-500">Version {edit.version}{current ? ' · Current' : ''}{edit.status !== 'completed' ? ` · ${edit.status}` : ''}</span>
                <span className="block truncate text-sm font-semibold text-slate-900">{edit.name?.trim() || edit.prompt || 'Untitled model'}</span>
                <time dateTime={edit.created_at} className="block text-xs text-slate-600">{new Date(edit.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
              </span>
              {!current && edit.status === 'completed' && <ArrowRight size={16} aria-hidden="true" className="shrink-0 text-slate-500" />}
            </button>
          </li>;
        })}
      </ul>
    </dialog>
  </>;
}
