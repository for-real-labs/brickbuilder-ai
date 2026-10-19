import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import posthog from 'posthog-js';
import { UpdateGenerationNameApiService } from '../services/updateGenerationNameApi';

export function GenerationTitle({ name, generationId, canEdit = false, saveLocally = false, accessToken, onSaved, variant = 'page', onEditRequest }: {
  name: string;
  generationId?: string;
  canEdit?: boolean;
  saveLocally?: boolean;
  accessToken?: string;
  onSaved?: (name: string) => void;
  variant?: 'page' | 'viewer' | 'order';
  onEditRequest?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = (canEdit || saveLocally) && !!generationId;
  const compact = variant === 'viewer';
  const order = variant === 'order';

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
      if (saveLocally && !canEdit) {
        onSaved?.(trimmed);
        setEditing(false);
        posthog.capture('order_model_name_saved', { generation_id: generationId, name_length: trimmed.length, persisted: false });
        return;
      }
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
    <div className={compact ? 'landing-model-heading' : order ? 'checkout-model-title' : 'mx-auto w-full max-w-2xl'}>
      {editing && allowed ? (
        <form onSubmit={save} className={compact ? 'landing-model-rename-form' : order ? 'checkout-model-rename-form' : 'space-y-2'} aria-label="Rename model">
          <label htmlFor="model-name" className={compact || order ? 'sr-only' : 'text-sm font-medium text-slate-600'}>Model name</label>
          <div className={compact ? 'landing-model-rename-controls' : order ? 'checkout-model-rename-controls' : 'flex flex-wrap gap-2'}>
            <input id="model-name" autoFocus value={draft} maxLength={200} disabled={saving}
              className={compact ? 'landing-model-rename-input' : order ? 'checkout-model-rename-input' : 'min-h-11 min-w-0 flex-1 basis-full rounded-xl border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 sm:basis-64'}
              onChange={event => { setDraft(event.target.value); setError(null); }}
              onKeyDown={event => { if (event.key === 'Escape' && !saving) { event.preventDefault(); cancel(); } }}
              aria-invalid={!!error} aria-describedby={error ? 'model-name-error' : undefined} />
            <button type="submit" disabled={saving || !draft.trim()} className={compact ? 'landing-model-rename-save' : order ? 'checkout-model-rename-save' : 'inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50'}>
              {saving && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}{saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" disabled={saving} onClick={cancel} className={compact ? 'landing-model-rename-cancel' : order ? 'checkout-model-rename-cancel' : 'min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50'}>Cancel</button>
          </div>
          {error && <p id="model-name-error" role="alert" className="text-sm text-red-600">{error}</p>}
          {order && saveLocally && !canEdit && <p className="checkout-model-rename-note">This name will be used for your kit.</p>}
        </form>
      ) : (
        <div className={compact ? 'landing-model-heading-row' : order ? 'checkout-model-heading-row' : 'flex items-start justify-center gap-2'}>
          {compact ? <h2 title={name}>{name}</h2> : order ? <h2 className="checkout-summary-heading">{name}</h2> : <h1 className="min-w-0 break-words text-center text-2xl font-semibold tracking-tight sm:text-3xl">{name}</h1>}
          {(allowed || onEditRequest) && <button type="button" aria-label="Rename model" className={compact ? 'landing-model-heading-edit' : order ? 'checkout-model-heading-edit' : 'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-900'}
            onClick={() => {
              if (!allowed) {
                posthog.capture('generation_name_edit_login_requested', { generation_id: generationId });
                onEditRequest?.();
                return;
              }
              setDraft(name); setError(null); setEditing(true);
              posthog.capture('generation_name_edit_started', { generation_id: generationId });
            }}><Pencil aria-hidden="true" className="h-4 w-4" /></button>}
        </div>
      )}
    </div>
  );
}
