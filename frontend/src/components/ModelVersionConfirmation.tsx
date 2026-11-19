import React, { useEffect, useId, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { GetGenerationsByImageApiService } from '../services/getGenerationsByImageApi';

export type ModelVersionAction = { id: string; kind: 'delete-model' }
  | { id: string; kind: 'restore' | 'delete-version'; version: number };

export function ModelVersionConfirmation({ action, token, source, onClose, onComplete }: {
  action: ModelVersionAction | null;
  token?: string;
  source: 'dashboard' | 'landing';
  onClose: () => void;
  onComplete: (action: ModelVersionAction, nextId: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  const active = useRef(false);
  const restoreRequest = useRef<{ generationId: string; id: string } | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  useEffect(() => {
    if (!action) return;
    const modal = dialog.current;
    setError(null);
    if (modal && !modal.open) modal.showModal();
    const properties = { generation_id: action.id };
    if (action.kind === 'restore') {
      posthog.capture(`${source}_model_restore_version_clicked`, { ...properties, version: action.version });
    } else {
      posthog.capture(`${source}_model_delete_prompt_opened`, { ...properties, scope: action.kind === 'delete-model' ? 'model' : 'version' });
    }
  }, [action, source]);

  const dismiss = () => {
    dialog.current?.close();
    onClose();
  };

  const confirm = async () => {
    if (!action || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      let nextId: string | null;
      if (action.kind === 'restore') {
        const request = restoreRequest.current?.generationId === action.id
          ? restoreRequest.current : { generationId: action.id, id: crypto.randomUUID() };
        restoreRequest.current = request;
        posthog.capture(`${source}_model_restore_version_confirmed`, { generation_id: action.id, version: action.version });
        nextId = await GetGenerationsByImageApiService.restoreVersion(action.id, request.id, token);
        restoreRequest.current = null;
      } else {
        const scope = action.kind === 'delete-model' ? 'model' : 'version';
        posthog.capture(`${source}_model_delete_confirmed`, { generation_id: action.id, scope });
        nextId = await GetGenerationsByImageApiService.deleteGeneration(action.id, scope, token);
      }
      if (active.current) {
        dismiss();
        onComplete(action, nextId);
      }
    } catch (failure) {
      if (active.current) {
        setError(failure instanceof Error ? failure.message : 'Could not update this model. Please try again.');
      }
    } finally {
      pending.current = false;
      if (active.current) setSubmitting(false);
    }
  };

  const restoring = action?.kind === 'restore';
  const label = restoring ? 'Restore version' : action?.kind === 'delete-model' ? 'Delete model' : 'Delete version';
  const title = action?.kind === 'delete-model' ? 'Delete model?'
    : action && `${restoring ? 'Restore' : 'Delete'} version ${action.version}?`;

  return <dialog ref={dialog} aria-labelledby={titleId} aria-describedby={descriptionId}
    className="m-auto w-[min(26rem,calc(100%-1.5rem))] rounded-2xl bg-white p-5 shadow-xl backdrop:bg-slate-900/40 sm:p-6"
    onCancel={event => { event.stopPropagation(); event.preventDefault(); if (!pending.current) dismiss(); }}>
    {action && <>
      <h2 id={titleId} className="text-lg font-semibold text-slate-900">{title}</h2>
      <p id={descriptionId} className="mt-2 text-sm leading-relaxed text-slate-600">
        {restoring ? 'This makes a copy of this version your current model. Your edit history stays available, and no credits are used.'
          : action.kind === 'delete-model' ? 'This removes your model and its edits from your dashboard and turns off their public links.'
          : 'This removes this version and its public link. If you delete the current version, BrickBuilder opens the newest remaining version.'}
      </p>
      {!restoring && <p className="mt-2 text-sm text-slate-600">You can’t undo this. Existing orders and purchased instructions stay available.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" autoFocus disabled={submitting} onClick={dismiss}
          className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">Cancel</button>
        <button type="button" disabled={submitting} onClick={() => void confirm()}
          className={`min-h-11 rounded-lg px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 ${restoring ? 'bg-slate-900 hover:bg-slate-800' : 'bg-red-700 hover:bg-red-800'}`}>
          {submitting ? (restoring ? 'Restoring…' : 'Deleting…') : label}
        </button>
      </div>
    </>}
  </dialog>;
}
