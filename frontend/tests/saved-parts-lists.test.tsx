import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardPartsLists, ScannerPartsList } from '../src/components/PartsListEditor';
import { SavedListImport } from '../src/components/SavedListPicker';
import { mergeParts, SavedLists, SaveConflict } from '../src/services/savedPartsLists';
import { PartsInventoryApi } from '../src/services/partsInventoryApi';
import { recognizeParts } from '../src/services/brickognizeApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { user: { id: 'owner' } } }) }));
vi.mock('../src/services/brickognizeApi', () => ({ recognizeParts: vi.fn() }));
const brick = { part_id: '3001', color_id: 4, quantity: 2 };
const list = { id: 'saved', name: 'Bulk bin', parts: [brick], revision: 1, piece_count: 2 };
let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(SavedLists, 'page').mockResolvedValue([list]);
  vi.spyOn(SavedLists, 'get').mockResolvedValue(list);
  vi.spyOn(SavedLists, 'save').mockResolvedValue(list);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const render = async (el: React.ReactNode) => act(async () => root.render(el));
const click = async (text: string) => act(async () => {
  [...host.querySelectorAll('button')].find(button => button.textContent?.includes(text))!.click();
});
async function field(label: string, value: string) {
  const control = [...host.querySelectorAll('label')].find(el => el.textContent?.startsWith(label))!.querySelector('input,select')!;
  const select = control instanceof HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(select ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event(select ? 'change' : 'input', { bubbles: true }));
  });
}
async function file(label: string) {
  const input = host.querySelector(`input[aria-label="${label}"]`)!;
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['file'], 'bricks.ldr')] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

it('reviews the top photo match, counts it and saves the same scanner draft after collapsing', async () => {
  vi.mocked(recognizeParts).mockResolvedValue([{ id: '3001', name: 'Brick 2 × 4', score: .92, imageUrl: null }]);
  await render(<ScannerPartsList owner="owner" />);
  await click('Single-part scanner'); await file('Upload a photo of LEGO parts');
  expect(host.textContent).toContain('Brick 2 × 4');
  await field('Color', '4'); await field('Quantity', '2'); await click('Add to list');
  await click('Single-part scanner'); await click('Single-part scanner'); await click('Save list');
  expect(SavedLists.save).toHaveBeenCalledWith('owner', expect.any(String), undefined, 'Bulk bin parts', [brick]);
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/dashboard?tab=parts-lists');
});

it('shows dashboard scanning when access is approved', async () => {
  await render(<DashboardPartsLists owner="owner" allowPhoto />);
  await click('Create parts list');
  await click('Scan one part');
  expect(host.querySelector('input[aria-label="Upload a photo of LEGO parts"]')).not.toBeNull();
});

it('hides dashboard scanning from other accounts and keeps manual entry and imports available', async () => {
  await render(<DashboardPartsLists owner="owner" allowPhoto={false} />);
  await click('Create parts list');
  expect(host.textContent).not.toContain('Scan one part');
  expect(host.querySelector('input[type=file]')).toBeNull();
  await field('List name', 'My bricks');
  await field('Part number', '3001');
  await field('Color', '4');
  await field('Quantity', '2');
  await click('Add to list');
  await click('Save list');
  expect(SavedLists.save).toHaveBeenCalledWith('owner', expect.any(String), undefined, 'My bricks', [brick]);
  await click('Import parts');
  expect(host.querySelector('input[aria-label="Upload parts list"]')).not.toBeNull();
});

it('combines an existing list with an LDR import, preserving colors and handling stale revisions', async () => {
  vi.spyOn(PartsInventoryApi, 'upload').mockResolvedValue({ inventory: { name: 'Import', source: 'upload', parts: [brick] }, unavailable: [] });
  vi.mocked(SavedLists.save).mockRejectedValueOnce(new SaveConflict());
  await render(<DashboardPartsLists owner="owner" />); await click('Bulk bin');
  await click('Import parts'); await file('Upload parts list'); await click('Save list');
  expect(SavedLists.save).toHaveBeenCalledWith('owner', 'saved', 1, 'Bulk bin', [{ ...brick, quantity: 4 }]);
  expect(host.textContent).toContain('A saved version already exists');
  await click('Save as a separate list');
  expect(vi.mocked(SavedLists.save).mock.lastCall?.[1]).not.toBe('saved');
  expect(host.textContent).toContain('Saved to Your parts lists');
});

it('imports the owner’s stored parts into the designer', async () => {
  const choose = vi.fn();
  await render(<SavedListImport onSelect={choose} />); await click('Your parts lists'); await click('Bulk bin');
  expect(SavedLists.get).toHaveBeenCalledWith('owner', 'saved', expect.any(AbortSignal));
  expect(choose).toHaveBeenCalledWith({ name: 'Bulk bin', source: 'upload', parts: [brick] });
});

it('merges equivalent LDraw IDs while keeping different colors separate', () => {
  expect(mergeParts([brick], [{ ...brick, part_id: '3001.DAT' }, { ...brick, color_id: 0 }]))
    .toEqual([{ ...brick, quantity: 4 }, { ...brick, color_id: 0 }]);
  for (const entry of [{ quantity: 99999 }, { quantity: .5 }, { part_id: 'a/b' }, { color_id: 16 }, { color_id: 24 }])
    expect(() => mergeParts([brick], [{ ...brick, ...entry }])).toThrow();
});
