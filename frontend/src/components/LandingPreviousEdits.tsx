import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, History, Package, RotateCcw, Trash2, X } from 'lucide-react';
import posthog from 'posthog-js';
import { GetGenerationsByImageApiService, type GenerationIteration } from '../services/getGenerationsByImageApi';

type DeleteTarget = { scope: 'model' | 'version'; edit: GenerationIteration };
const canDeleteVersion = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

export function LandingPreviousEdits({ id, token, busy, onView, onDeleteModel }: {
  id: string; token?: string; busy: boolean; onView: (id: string) => void; onDeleteModel?: () => void;
}) {
  const [edits, setEdits] = useState<GenerationIteration[]>([]);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreRequest = useRef<{ id: string; pending: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const confirmation = useRef<HTMLDialogElement>(null);
  const title = useId();
  const deleteTitle = useId();
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef<DeleteTarget | null>(null);

  useEffect(() => {
    let active = true;
    setEdits([]);
    setRestoring(false);
    setRestoreError(null);
    setDeleting(false);
    setDeleteTarget(null);
    confirmation.current?.close();
    void GetGenerationsByImageApiService.getGenerationsByImage(token, id).then(({ generations }) => {
      if (!active) return;
      setEdits([...generations].sort((a, b) => b.version - a.version || a.id.localeCompare(b.id)));
    }).catch(() => { /* A private or unavailable history should not affect the viewer. */ });
    return () => { active = false; restoreRequest.current = null; deletePending.current = null; };
  }, [id, token]);

  const latestCompletedEdit = edits.find(edit => edit.status === 'completed');
  const viewedEdit = edits.find(edit => edit.id === id);
  const ownedModel = viewedEdit && onDeleteModel;
  const viewingOlderVersion = viewedEdit?.status === 'completed' &&
    latestCompletedEdit !== undefined && viewedEdit.version < latestCompletedEdit.version;

  function askToDelete(target: DeleteTarget) {
    setDeleteError(null);
    setDeleteTarget(target);
    confirmation.current?.showModal();
    posthog.capture('landing_model_delete_prompt_opened', { generation_id: target.edit.id, scope: target.scope });
  }

  async function confirmDelete() {
    if (!deleteTarget || deletePending.current || busy || restoring) return;
    const target = deleteTarget;
    deletePending.current = target;
    setDeleting(true);
    setDeleteError(null);
    posthog.capture('landing_model_delete_confirmed', { generation_id: target.edit.id, scope: target.scope });
    try {
      const next = await GetGenerationsByImageApiService.deleteGeneration(target.edit.id, target.scope, token);
      if (deletePending.current !== target) return;
      confirmation.current?.close();
      setDeleteTarget(null);
      if (target.scope === 'model' || target.edit.id === id) {
        dialog.current?.close();
        if (next) onView(next);
        else onDeleteModel?.();
      } else {
        setEdits(current => current.filter(edit => edit.id !== target.edit.id));
        dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    } catch (error) {
      if (deletePending.current === target) {
        setDeleteError(error instanceof Error ? error.message : 'Could not delete this model. Please try again.');
      }
    } finally {
      if (deletePending.current === target) {
        deletePending.current = null;
        setDeleting(false);
      }
    }
  }

  async function restoreVersion() {
    if (busy || restoreRequest.current?.pending || deletePending.current) return;
    const request = restoreRequest.current ?? { id: crypto.randomUUID(), pending: false };
    restoreRequest.current = request;
    request.pending = true;
    setRestoring(true);
    setRestoreError(null);
    posthog.capture('landing_model_restore_version_clicked', { generation_id: id, version: viewedEdit?.version });
    try {
      const restoredId = await GetGenerationsByImageApiService.restoreVersion(id, request.id, token);
      if (restoreRequest.current === request) onView(restoredId);
    } catch (error) {
      if (restoreRequest.current === request) {
        setRestoreError(error instanceof Error ? error.message : 'Could not restore this version. Please try again.');
      }
    } finally {
      request.pending = false;
      if (restoreRequest.current === request) setRestoring(false);
    }
  }

  return <>
    {edits.length > 1 && <button type="button" className="landing-action-button" disabled={busy || restoring || deleting} aria-haspopup="dialog"
      onClick={() => {
        dialog.current?.showModal();
        posthog.capture('landing_model_previous_edits_opened', { generation_id: id, edit_count: edits.length });
      }}><History size={16} aria-hidden="true" />Previous edits</button>}
    {viewingOlderVersion && <button type="button" className="landing-action-button landing-restore-version"
      disabled={busy || restoring || deleting} onClick={() => { void restoreVersion(); }}>
      <RotateCcw size={16} aria-hidden="true" />{restoring ? 'Restoring…' : 'Restore this version'}
    </button>}
    {ownedModel && <button type="button" className="landing-action-button landing-delete-model" aria-haspopup="dialog"
      disabled={busy || restoring || deleting} onClick={() => askToDelete({ scope: 'model', edit: viewedEdit })}>
      <Trash2 size={16} aria-hidden="true" />Delete model
    </button>}
    {restoreError && <p className="basis-full text-sm text-red-700" role="alert">{restoreError}</p>}
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
          return <li key={edit.id} className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white shadow-sm hover:border-red-200 sm:gap-2">
            <button type="button" className="landing-version-view flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 text-left focus-visible:outline-2 focus-visible:outline-red-500"
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
                <span className="block text-xs font-medium text-slate-500">Version {edit.version}{current ? (viewingOlderVersion ? ' · Viewing' : ' · Current') : ''}{edit.status !== 'completed' ? ` · ${edit.status}` : ''}</span>
                <span className="block truncate text-sm font-semibold text-slate-900">{edit.name?.trim() || edit.prompt || 'Untitled model'}</span>
                <time dateTime={edit.created_at} className="block text-xs text-slate-600">{new Date(edit.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
              </span>
              {!current && edit.status === 'completed' && <ArrowRight size={16} aria-hidden="true" className="shrink-0 text-slate-500" />}
            </button>
            {ownedModel && canDeleteVersion(edit.status) && <button type="button" aria-label={`Delete version ${edit.version}`}
              title={`Delete version ${edit.version}`} disabled={busy || restoring || deleting}
              className="mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-700 focus-visible:outline-2 focus-visible:outline-red-500"
              onClick={() => askToDelete({ scope: 'version', edit })}>
              <Trash2 size={17} aria-hidden="true" />
            </button>}
          </li>;
        })}
      </ul>
    </dialog>
    <dialog ref={confirmation} aria-labelledby={deleteTitle}
      className="landing-delete-confirmation m-auto w-[min(26rem,calc(100%-1.5rem))] rounded-2xl bg-white p-5 shadow-xl backdrop:bg-slate-900/40 sm:p-6"
      onCancel={event => { if (deleting) event.preventDefault(); }}>
      {deleteTarget && <>
        <h2 id={deleteTitle} className="text-lg font-semibold text-slate-900">
          {deleteTarget.scope === 'model' ? 'Delete model?' : `Delete version ${deleteTarget.edit.version}?`}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {deleteTarget.scope === 'model'
            ? 'This removes the model, its edit history, and its public links from BrickBuilder.'
            : 'This removes this version and its public link from BrickBuilder. The other versions stay in your history.'}
        </p>
        <p className="mt-1 text-sm text-slate-600">You can’t undo this. Existing orders and purchased instructions stay available.</p>
        {deleteError && <p role="alert" className="mt-3 text-sm text-red-700">{deleteError}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" autoFocus disabled={deleting} className="landing-action-button"
            onClick={() => confirmation.current?.close()}>Cancel</button>
          <button type="button" disabled={deleting || busy} onClick={() => { void confirmDelete(); }}
            className="min-h-11 rounded-full bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:opacity-50">
            {deleting ? 'Deleting…' : deleteTarget.scope === 'model' ? 'Delete model' : 'Delete version'}
          </button>
        </div>
      </>}
    </dialog>
  </>;
}
