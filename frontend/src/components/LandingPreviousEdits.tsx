import React, { useEffect, useId, useRef, useState } from 'react';
import { Eye, History, Package, RotateCcw, Trash2, X } from 'lucide-react';
import posthog from 'posthog-js';
import { GetGenerationsByImageApiService, type GenerationIteration } from '../services/getGenerationsByImageApi';
import { ModelVersionConfirmation, type ModelVersionAction } from './ModelVersionConfirmation';

const rowAction = 'inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-45';

export function LandingPreviousEdits({ id, historyId, token, busy, onView, onNoVersion }: {
  id: string; historyId?: string; token?: string; busy: boolean; onView: (id: string, historyId?: string) => void; onNoVersion?: () => void;
}) {
  const [edits, setEdits] = useState<GenerationIteration[]>([]);
  const [action, setAction] = useState<ModelVersionAction | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();

  const anchor = historyId || id;
  useEffect(() => {
    let active = true;
    setEdits([]);
    void GetGenerationsByImageApiService.getGenerationsByImage(token, anchor).then(({ generations }) => {
      if (!active) return;
      setEdits([...generations].sort((a, b) => b.version - a.version || a.id.localeCompare(b.id)));
    }).catch(() => { /* A private or unavailable history should not affect the viewer. */ });
    return () => { active = false; };
  }, [anchor, token]);

  const current = edits.find(edit => !edit.is_fork_source && edit.status === 'completed');
  if (!edits.some(edit => edit.id === id)) return null;

  const finishAction = (confirmed: ModelVersionAction, nextId: string | null) => {
    if (confirmed.kind === 'delete-version') {
      setEdits(versions => versions.filter(version => version.id !== confirmed.id));
      if (confirmed.id !== id && confirmed.id !== current?.id) return;
    }
    if (nextId === id) return;
    dialog.current?.close();
    if (nextId) onView(nextId);
    else onNoVersion?.();
  };

  return <>
    <button type="button" className="landing-action-button" disabled={busy} aria-haspopup="dialog"
      onClick={() => {
        dialog.current?.showModal();
        posthog.capture('landing_model_previous_edits_opened', { generation_id: id, edit_count: edits.length });
      }}><History size={16} aria-hidden="true" />Previous edits</button>
    <dialog ref={dialog} aria-labelledby={title} onCancel={event => event.stopPropagation()}
      className="landing-previous-edits-dialog m-auto max-h-[85dvh] w-[min(36rem,calc(100%-1.5rem))] overflow-y-auto rounded-2xl bg-slate-50 shadow-xl backdrop:bg-slate-900/40">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 sm:px-5">
        <h2 id={title} className="text-lg font-semibold text-slate-900">Previous edits</h2>
        <button type="button" aria-label="Close previous edits" className="landing-action-button !px-3" onClick={() => dialog.current?.close()}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <ul className="space-y-2 p-3 sm:p-5">
        {edits.map(edit => {
          const viewing = edit.id === id;
          const completed = edit.status === 'completed';
          const isCurrent = edit.id === current?.id;
          const canRestore = !edit.is_fork_source && completed && current !== undefined && edit.version < current.version;
          const canDelete = completed || edit.status === 'failed' || edit.status === 'cancelled';
          const label = edit.is_fork_source ? 'Original model' : `Version ${edit.version}`;
          const image = edit.preview_image_url || edit.external_image_url || edit.thumbnail_url || edit.image_url || edit.processed_image_url;
          return <li key={edit.id} aria-current={viewing ? 'true' : undefined}
            className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-100 text-slate-400">
                {image ? <img src={image} alt="" loading="lazy" className="h-full w-full object-contain" /> : <Package size={20} aria-hidden="true" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-slate-500">{label}{isCurrent ? ' · Current' : viewing ? ' · Viewing' : ''}{!completed ? ` · ${edit.status}` : ''}</span>
                <span className="block truncate text-sm font-semibold text-slate-900">{edit.name?.trim() || edit.prompt || 'Untitled model'}</span>
                <time dateTime={edit.created_at} className="block text-xs text-slate-600">{new Date(edit.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
              </span>
            </div>
            <div className="flex flex-wrap justify-end gap-1.5">
              <button type="button" className={rowAction} aria-label={edit.is_fork_source ? 'View original model' : `View version ${edit.version}`} disabled={busy || !completed}
                onClick={() => {
                  dialog.current?.close();
                  if (viewing) return;
                  posthog.capture('landing_model_previous_edit_viewed', { generation_id: id, viewed_generation_id: edit.id, version: edit.is_fork_source ? undefined : edit.version, is_fork_source: Boolean(edit.is_fork_source) });
                  if (edit.is_fork_source) onView(edit.id, current?.id);
                  else onView(edit.id);
                }}><Eye size={15} aria-hidden="true" />View</button>
              {!edit.is_fork_source && <>
                <button type="button" className={rowAction} aria-label={`Restore version ${edit.version}`} aria-haspopup="dialog"
                  title={isCurrent ? 'This is the current version' : undefined}
                  disabled={busy || !canRestore} onClick={() => setAction({ kind: 'restore', id: edit.id, version: edit.version })}>
                  <RotateCcw size={14} aria-hidden="true" />Restore
                </button>
                <button type="button" className={`${rowAction} w-11 px-0 hover:bg-red-50 hover:text-red-700`}
                  aria-label={`Delete version ${edit.version}`} title={`Delete version ${edit.version}`} aria-haspopup="dialog"
                  disabled={busy || !canDelete} onClick={() => setAction({ kind: 'delete-version', id: edit.id, version: edit.version })}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </>}
            </div>
          </li>;
        })}
      </ul>
    </dialog>
    <ModelVersionConfirmation action={action} token={token} source="landing" onClose={() => setAction(null)} onComplete={finishAction} />
  </>;
}
