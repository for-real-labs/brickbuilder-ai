import { getGuestSession } from '../utils/guestSession';
import { useCallback, useEffect, useRef, useState } from 'react';
import { GetGenerationApiService } from '../services/getGenerationApi';
import { GetUserGenerationsApiService } from '../services/getUserGenerationsApi';

export interface GenerationActivity {
  id: string;
  prompt: string;
  status: string;
  endpoint?: string;
  imageUrl?: string;
  errorMessage?: string;
}

export const isGenerationActive = (status: string) =>
  ['queued', 'started', 'processing', 'ldr_processing'].includes(status);

const storageKey = (owner: string) => `pending_generations:${owner}`;

function restore(owner: string): GenerationActivity[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey(owner)) || '[]');
    return Array.isArray(value) ? value.filter((row): row is GenerationActivity =>
      row && typeof row.id === 'string' && typeof row.prompt === 'string' && isGenerationActive(row.status),
    ) : [];
  } catch {
    return [];
  }
}

function persist(owner: string, rows: GenerationActivity[]) {
  try {
    localStorage.setItem(storageKey(owner), JSON.stringify(rows.filter(row => isGenerationActive(row.status))));
  } catch { /* Status recovery through the API still works without browser storage. */ }
}

export function useGenerationActivity(owner: string, authToken: string | undefined, enabled: boolean) {
  // Version the cache so IDs previously leaked into guest storage are discarded.
  owner = `v2:${authToken ? owner : `guest:${getGuestSession()}`}`;
  const [generations, setGenerations] = useState<GenerationActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const rows = useRef<GenerationActivity[]>([]);
  const currentOwner = useRef(owner);

  const trackGeneration = useCallback((generation: GenerationActivity) => {
    if (currentOwner.current !== owner) return;
    rows.current = [generation, ...rows.current.filter(row => row.id !== generation.id)];
    persist(owner, rows.current);
    setGenerations(rows.current);
  }, [owner]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    if (currentOwner.current !== owner || rows.current.length === 0) {
      rows.current = restore(owner);
      currentOwner.current = owner;
    }
    setGenerations(rows.current);
    setError(null);
    if (!enabled) return;

    const refresh = async () => {
      try {
        const active = await GetUserGenerationsApiService.getProcessingGenerations(authToken, controller.signal);
        if (controller.signal.aborted) return;
        const activeIds = new Set(active.map(row => row.id));
        // Jobs absent from the active list may have completed while this page
        // was closed. Keep their result cards so the user can open each model.
        const missing = rows.current.filter(row => isGenerationActive(row.status) && !activeIds.has(row.id));
        const settled = await Promise.allSettled(missing.map(async row => {
          const status = await GetGenerationApiService.getGeneration(row.id, controller.signal);
          return { ...row, status: status.status, prompt: status.prompt || row.prompt,
            imageUrl: status.external_image_url || row.imageUrl,
            errorMessage: status.error_message || undefined };
        }));
        if (controller.signal.aborted) return;
        const updates = new Map<string, GenerationActivity>(active.map(row => [row.id, {
          id: row.id, prompt: row.prompt, status: row.status, endpoint: row.endpoint,
          imageUrl: row.preview_image_url || row.processed_image_url || row.external_image_url,
        }]));
        for (const result of settled) {
          if (result.status === 'fulfilled') updates.set(result.value.id, result.value);
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
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5_000);
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
