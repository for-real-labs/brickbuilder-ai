import { getGuestSession } from '../utils/guestSession';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GetGenerationApiService } from '../services/getGenerationApi';
import { GetUserGenerationsApiService } from '../services/getUserGenerationsApi';

export interface GenerationActivity {
  id: string;
  prompt: string;
  name?: string | null;
  status: string;
  endpoint?: string;
  createdAt?: string;
  durationSeconds?: number | null;
  imageUrl?: string;
  errorMessage?: string;
  previewWaitUntil?: number;
}

export const isPreviewPending = (row: GenerationActivity) =>
  row.status === 'completed' && !!row.previewWaitUntil && row.previewWaitUntil > Date.now();

const PREVIEW_WAIT_MS = 60_000;

export const isGenerationActive = (status: string) =>
  ['queued', 'started', 'processing', 'ldr_processing', 'resizing'].includes(status);

const storageKey = (owner: string) => `pending_generations:${owner}`;
const keepActivity = (row: GenerationActivity) => isGenerationActive(row.status) || isPreviewPending(row)
  || (row.endpoint === 'novaToBricks' && ['failed', 'cancelled'].includes(row.status));

function restore(owner: string): GenerationActivity[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(owner)) || '[]');
    return Array.isArray(value) ? value.filter((row): row is GenerationActivity =>
      row && typeof row.id === 'string' && typeof row.prompt === 'string' && keepActivity(row),
    ) : [];
  } catch {
    return [];
  }
}

function persist(owner: string, rows: GenerationActivity[]) {
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(rows.filter(keepActivity)));
  } catch { /* Status recovery through the API still works without browser storage. */ }
}

export function useGenerationActivity(owner: string, authToken: string | undefined, enabled: boolean) {
  // Version the cache so IDs previously leaked into guest storage are discarded.
  owner = `v2:${authToken ? owner : `guest:${getGuestSession()}`}`;
  const [generations, setGenerations] = useState<GenerationActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const rows = useRef<GenerationActivity[]>([]);
  const currentOwner = useRef(owner);

  useEffect(() => {
    if (!enabled) return;
    const deadlines = generations.filter(isPreviewPending).map(row => row.previewWaitUntil!);
    if (!deadlines.length) return;
    // This timer is independent of network requests, which may themselves stall.
    const timeout = setTimeout(() => {
      persist(owner, rows.current);
      setGenerations([...rows.current]);
    }, Math.max(0, Math.min(...deadlines) - Date.now()));
    return () => clearTimeout(timeout);
  }, [generations, owner, enabled]);

  const trackGeneration = useCallback((generation: GenerationActivity, replacesId?: string) => {
    if (currentOwner.current !== owner) return;
    rows.current = [generation, ...rows.current.filter(row => row.id !== generation.id && row.id !== replacesId)];
    persist(owner, rows.current);
    setGenerations(rows.current);
  }, [owner]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let recoveredResumable = false;
    if (currentOwner.current !== owner || rows.current.length === 0) {
      rows.current = restore(owner);
      currentOwner.current = owner;
    }
    setGenerations(rows.current);
    setError(null);
    if (!enabled) return;

    const refresh = async () => {
      try {
        const recovery = !recoveredResumable
          ? GetUserGenerationsApiService.getResumableNovaGenerations(authToken, controller.signal).catch(() => [])
          : Promise.resolve([]);
        recoveredResumable = true;
        const [active, resumable] = await Promise.all([
          GetUserGenerationsApiService.getProcessingGenerations(authToken, controller.signal), recovery,
        ]);
        if (controller.signal.aborted) return;
        const activeIds = new Set(active.map(row => row.id));
        // Jobs absent from the active list may have completed while this page
        // was closed. Keep their result cards so the user can open each model.
        const missing = rows.current.filter(row => (isGenerationActive(row.status) || isPreviewPending(row)) && !activeIds.has(row.id));
        const settled = await Promise.allSettled(missing.map(async row => {
          const status = await GetGenerationApiService.getGeneration(row.id, controller.signal);
          const previewWaitUntil = status.status === 'completed' && !status.preview_image_url
            ? row.previewWaitUntil ?? Date.now() + PREVIEW_WAIT_MS : undefined;
          return { ...row, status: status.status, prompt: status.prompt || row.prompt, name: status.name || row.name,
            createdAt: status.created_at || row.createdAt,
            durationSeconds: status.generation_duration_seconds ?? row.durationSeconds,
            previewWaitUntil,
            imageUrl: status.preview_image_url || status.processed_image_url || status.external_image_url || row.imageUrl,
            errorMessage: status.error_message || undefined };
        }));
        if (controller.signal.aborted) return;
        const updates = new Map<string, GenerationActivity>([...resumable, ...active].map(row => [row.id, {
          durationSeconds: row.generation_duration_seconds,
          id: row.id, prompt: row.prompt, name: row.name, status: row.status, endpoint: row.endpoint,
          createdAt: row.created_at || rows.current.find(saved => saved.id === row.id)?.createdAt,
          imageUrl: row.preview_image_url || row.processed_image_url || row.external_image_url,
          errorMessage: row.error_message,
        }]));
        for (const result of settled) {
          if (result.status === 'fulfilled') updates.set(result.value.id, result.value);
        }
        // A refresh started before cancellation must not revive a stopped card.
        for (const row of rows.current) {
          if (row.status === 'cancelled') updates.set(row.id, row);
        }
        // Read the latest rows here so a job submitted during a refresh isn't lost.
        rows.current = [...updates.values(), ...rows.current.filter(row => !updates.has(row.id))];
        persist(owner, rows.current);
        setGenerations(rows.current);
        setError(settled.some(result => result.status === 'rejected')
          ? 'Some statuses could not be refreshed. Retrying…' : null);
      } catch {
        if (!controller.signal.aborted) setError('Unable to refresh generations. Retrying…');
      } finally {
        if (!controller.signal.aborted) {
          // Expire the spinner even when an API refresh fails. Preserve the deadline
          // so a missing preview never starts another waiting period.
          setGenerations([...rows.current]);
          timer = setTimeout(refresh, 5_000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [owner, authToken, enabled]);

  return { generations: enabled && currentOwner.current === owner ? generations : [], error, trackGeneration };
}
