import { supabase } from '../lib/supabase';
import type { InventoryPart } from './partsInventoryApi';

export interface PartsListSummary { id: string; name: string; piece_count: number; revision: number }
export interface SavedPartsList extends PartsListSummary { parts: InventoryPart[] }
const table = 'saved_parts_lists';
const summary = 'id,name,piece_count,revision';
export const listsPerPage = 25;

export function mergeParts(current: InventoryPart[], additions: InventoryPart[]): InventoryPart[] {
  const rows = new Map<string, InventoryPart>();
  let count = 0;
  for (const part of [...current, ...additions]) {
    const part_id = part.part_id.trim().toLowerCase().replace(/^parts\//, '').replace(/\.dat$/, '');
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(part_id)) throw new Error('Enter a valid LDraw part number.');
    if (!Number.isInteger(part.color_id) || part.color_id < 0 || part.color_id > 65535 || [16, 24].includes(part.color_id))
      throw new Error('Choose a specific LDraw color.');
    if (!Number.isInteger(part.quantity) || part.quantity < 1) throw new Error('Enter a positive whole-number quantity.');
    count += part.quantity;
    const key = part_id + ':' + part.color_id;
    rows.set(key, { ...part, part_id, quantity: (rows.get(key)?.quantity ?? 0) + part.quantity });
  }
  if (count > 100000 || rows.size > 10000) throw new Error('A list can hold up to 100,000 pieces and 10,000 distinct part and color pairs.');
  return [...rows.values()];
}

export const SavedLists = {
  async page(owner: string, offset: number, signal: AbortSignal): Promise<PartsListSummary[]> {
    const { data, error } = await supabase.from(table).select(summary).eq('owner_id', owner)
      .order('updated_at', { ascending: false }).order('id').range(offset, offset + listsPerPage - 1).abortSignal(signal);
    if (error) throw new Error('Could not load your parts lists. Try again.');
    return data;
  },
  async get(owner: string, id: string, signal: AbortSignal): Promise<SavedPartsList> {
    const { data, error } = await supabase.from(table).select(summary + ',parts').eq('owner_id', owner).eq('id', id).abortSignal(signal).single();
    if (error) throw new Error('Could not open this parts list. Try again.');
    return data as unknown as SavedPartsList;
  },
  async save(owner: string, id: string, revision: number | undefined, name: string, parts: InventoryPart[]): Promise<PartsListSummary> {
    const values = { name: name.trim(), parts };
    const query = revision === undefined
      ? supabase.from(table).insert({ ...values, id, owner_id: owner })
      : supabase.from(table).update(values).eq('owner_id', owner).eq('id', id).eq('revision', revision);
    const { data, error } = await query.select(summary).maybeSingle();
    if ((!error && !data) || error?.code === '23505') throw new SaveConflict();
    if (error || !data) throw new Error('Could not save your parts list. Check your connection and try again.');
    return data;
  },
};
export class SaveConflict extends Error {
  constructor() { super('A saved version already exists. You can save these changes as a separate list.'); }
}
