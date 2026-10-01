import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import posthog from 'posthog-js';
import { UpdateGenerationNameApiService } from '../services/updateGenerationNameApi';

export function GenerationTitle({ name, generationId, canEdit = false, accessToken, onSaved }: {
  name: string;
  generationId?: string;
  canEdit?: boolean;
  accessToken?: string;
  onSaved?: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = canEdit && !!generationId;

  useEffect(() => {
    if (!allowed) setEditing(false);
  }, [allowed]);

  const cancel = () => {
    setEditing(false);
    setError(null);
    posthog.capture('generation_name_edit_cancelled', { generation_id: generationId });
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!allowed || saving) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed.length > 200) {
      setError('Enter a name between 1 and 200 characters.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await UpdateGenerationNameApiService.updateGenerationName(generationId!, trimmed, accessToken);
      if (!mounted.current) return;
      onSaved?.(result.name);
      setEditing(false);
      posthog.capture('generation_name_saved', { generation_id: generationId, name_length: result.name.length });
    } catch {
      if (!mounted.current) return;
      setError('Could not save the name. Please try again.');
      posthog.capture('generation_name_save_failed', { generation_id: generationId });
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl">
      {editing && allowed ? (
        <form onSubmit={save} className="space-y-2" aria-label="Rename model">
          <label htmlFor="model-name" className="text-sm font-medium text-slate-600">Model name</label>
          <div className="flex flex-wrap gap-2">
            <input id="model-name" autoFocus value={draft} maxLength={200} disabled={saving}
              className="min-h-11 min-w-0 flex-1 basis-full rounded-xl border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 sm:basis-64"
              onChange={event => { setDraft(event.target.value); setError(null); }}
              onKeyDown={event => { if (event.key === 'Escape' && !saving) { event.preventDefault(); cancel(); } }}
              aria-invalid={!!error} aria-describedby={error ? 'model-name-error' : undefined} />
            <button type="submit" disabled={saving || !draft.trim()} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {saving && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" disabled={saving} onClick={cancel} className="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50">Cancel</button>
          </div>
          {error && <p id="model-name-error" role="alert" className="text-sm text-red-600">{error}</p>}
        </form>
      ) : (
        <div className="flex items-start justify-center gap-2">
          <h1 className="min-w-0 break-words text-center text-2xl font-semibold tracking-tight sm:text-3xl">{name}</h1>
          {allowed && <button type="button" aria-label="Rename model" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            onClick={() => {
              setDraft(name); setError(null); setEditing(true);
              posthog.capture('generation_name_edit_started', { generation_id: generationId });
            }}><Pencil aria-hidden="true" className="h-4 w-4" /></button>}
        </div>
      )}
    </div>
  );
}
