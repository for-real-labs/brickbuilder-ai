import { apiFetch } from './apiFetch';
import { NOVA_API_BASE_URL } from './novaToBricksApi';

export interface InventoryPart { part_id: string; color_id: number; quantity: number }
export interface PartsInventory { name: string; source: 'upload' | 'set'; parts: InventoryPart[] }
export interface InventoryResult {
  inventory: PartsInventory;
  unavailable: InventoryPart[];
  source_url?: string;
  catalog_updated_at?: string;
}
export interface LegoSet { set_num: string; name: string; year: number; num_parts: number }
export const inventoryQuantity = (inventory: PartsInventory) => inventory.parts.reduce((total, part) => total + part.quantity, 0);

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Could not load this parts list. Please try again.');
  return data as T;
}

export const PartsInventoryApi = {
  async upload(file: File, signal?: AbortSignal): Promise<InventoryResult> {
    if (file.size > 16 * 1024 * 1024) throw new Error('Choose a parts list smaller than 16 MB.');
    const body = new FormData();
    body.append('file', file);
    return readResponse(await apiFetch(`${NOVA_API_BASE_URL}/parts-inventory/upload`, { method: 'POST', body, signal }));
  },
  async search(query: string, signal?: AbortSignal): Promise<LegoSet[]> {
    const data = await readResponse<{ sets: LegoSet[] }>(await apiFetch(`${NOVA_API_BASE_URL}/parts-inventory/sets?q=${encodeURIComponent(query.trim())}`, { signal }));
    return data.sets;
  },
  async select(setNumber: string, signal?: AbortSignal): Promise<InventoryResult> {
    return readResponse(await apiFetch(`${NOVA_API_BASE_URL}/parts-inventory/sets/${encodeURIComponent(setNumber)}`, { signal }));
  },
};
