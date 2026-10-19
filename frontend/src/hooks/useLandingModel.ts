import { useCallback, useEffect, useRef, useState } from 'react';
import posthog from 'posthog-js';
import { GetGenerationApiService, type GetGenerationResponse } from '../services/getGenerationApi';
import { LdrToMpdApiService } from '../services/ldrToMpdApi';
import { startPolling } from '../utils/polling';

export interface LandingModel {
  generation: GetGenerationResponse;
  content: string;
}

/** Loads a selected build while retaining the previous geometry during an edit. */
export function useLandingModel(owner: string, authToken?: string, requestedId?: string | null) {
  const storageKey = `brickbuilder.landing-model:${owner}`;
  const [targetId, setTargetId] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [model, setModel] = useState<LandingModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const selection = useRef<{ storageKey: string; id: string | null } | null>(null);
  const open = useCallback((id: string, retainModel = false) => {
    selection.current = { storageKey, id };
    try { sessionStorage.setItem(storageKey, id); } catch { /* The viewer works without storage. */ }
    revision.current++;
    if (!retainModel) setModel(null);
    setError(null);
    setBusy(true);
    setTargetId(id);
    setLoadVersion(current => current + 1);
  }, [storageKey]);
  const reset = useCallback(() => {
    selection.current = { storageKey, id: null };
    try { sessionStorage.removeItem(storageKey); } catch { /* Keep the reset for this visit. */ }
    revision.current++;
    setTargetId(null);
    setModel(null);
    setBusy(false);
    setError(null);
  }, [storageKey]);
  const rename = useCallback((id: string, name: string) => {
    setModel(current => current?.generation.generation_id === id
      ? { ...current, generation: { ...current.generation, name } } : current);
  }, []);
  useEffect(() => {
    // A plain landing visit starts fresh. Only explicit model links restore a viewer.
    const id = requestedId || null;
    if (selection.current?.storageKey === storageKey && selection.current.id === id) return;
    selection.current = { storageKey, id };
    if (requestedId) {
      try { sessionStorage.setItem(storageKey, requestedId); } catch { /* Deep links work without storage. */ }
    } else {
      try { sessionStorage.removeItem(storageKey); } catch { /* Ignore a stale workspace when storage is unavailable. */ }
    }
    revision.current++;
    setTargetId(id);
    setModel(null);
    setBusy(Boolean(id));
    setError(null);
    setLoadVersion(current => current + 1);
  }, [storageKey, requestedId]);

  useEffect(() => {
    if (!targetId) return;
    const currentRevision = revision.current;
    let settled = false;
    const polling = startPolling(async signal => {
      if (settled) return;
      try {
        const generation = await GetGenerationApiService.getGeneration(targetId, signal);
        if (signal.aborted || revision.current !== currentRevision) return;
        if (generation.status === 'failed' || generation.status === 'cancelled') {
          settled = true;
          polling.stop();
          setBusy(false);
          setError(generation.status === 'cancelled' ? 'This build was cancelled.' : generation.error_message || 'Unable to finish this build.');
          return;
        }
        if (generation.status !== 'completed') return;
        let content: string | undefined;
        if (generation.mpd_url) {
          try {
            const response = await fetch(generation.mpd_url, { signal });
            if (response.ok) content = await response.text();
          } catch (error) { if (signal.aborted) throw error; }
        }
        if (!content && generation.ldr_content) {
          const converted = await LdrToMpdApiService.convertLdrToMpd(generation.ldr_content, generation.name || generation.prompt || 'My model', authToken);
          content = converted.mpd_content;
        }
        if (signal.aborted || revision.current !== currentRevision) return;
        if (!content) throw new Error('The model could not be loaded. Retrying…');
        settled = true;
        polling.stop();
        setModel({ generation, content });
        setBusy(false);
        setError(null);
        posthog.capture('landing_model_viewed', { generation_id: targetId, endpoint: generation.endpoint });
      } catch (error) {
        if (signal.aborted || revision.current !== currentRevision) return;
        setError(error instanceof Error ? error.message : 'Unable to load this model. Retrying…');
        throw error;
      }
    }, { intervalMs: 5000 });
    return polling.stop;
  }, [targetId, authToken, loadVersion]);

  return { targetId, model, busy, error, open, reset, rename };
}
