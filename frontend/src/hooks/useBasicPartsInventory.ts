import { useEffect, useState } from 'react';
import { PartsInventoryApi, type BasicInventoryCompatibility, type PartsInventory } from '../services/partsInventoryApi';

export function useBasicPartsInventory(inventory: PartsInventory | null) {
  const [state, setState] = useState<{ source: PartsInventory | null; result?: BasicInventoryCompatibility; error?: string }>({ source: null });
  useEffect(() => {
    if (!inventory) return;
    const controller = new AbortController();
    void PartsInventoryApi.basicCompatibility(inventory, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ source: inventory, result });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ source: inventory, error: error instanceof Error ? error.message : 'Could not check the Basic bricks palette.' });
    });
    return () => controller.abort();
  }, [inventory]);
  const current = state.source === inventory ? state : {};
  return { result: current.result, error: current.error, loading: Boolean(inventory && !current.result && !current.error) };
}
