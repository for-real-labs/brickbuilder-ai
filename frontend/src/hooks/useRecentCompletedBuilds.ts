import { useEffect, useState } from 'react';
import { GetUserGenerationsApiService, type GenerationWithOrder } from '../services/getUserGenerationsApi';

/** Read every dashboard page so the completed count includes already viewed builds. */
export function useRecentCompletedBuilds(authToken?: string, userId?: string, refreshKey = '') {
  const [completed, setCompleted] = useState<GenerationWithOrder[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      const rows: GenerationWithOrder[] = [];
      let offset = 0;
      try {
        while (!controller.signal.aborted) {
          const page = await GetUserGenerationsApiService.getUserGenerations(authToken, 50, offset, false, controller.signal, false);
          rows.push(...(page.generations || []));
          if (!page.has_more || !page.generations?.length) break;
          offset += page.generations.length;
        }
        if (!controller.signal.aborted) setCompleted(rows.filter(row => row.status === 'completed')
          .sort((a, b) => b.created_at.localeCompare(a.created_at)));
      } catch (error) {
        if (!controller.signal.aborted) console.warn('Unable to load recent builds', error);
      }
    };
    void load();
    return () => controller.abort();
  }, [authToken, userId, refreshKey]);
  return completed;
}
