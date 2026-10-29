import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExistingPartsDesigner } from '../src/components/ExistingPartsDesigner';
import { PartsInventoryApi } from '../src/services/partsInventoryApi';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/partsInventoryApi', () => ({
  inventoryQuantity: (v: { parts: { quantity: number }[] }) => v.parts.reduce((n, p) => n + p.quantity, 0),
  PartsInventoryApi: { upload: vi.fn(), search: vi.fn(), select: vi.fn() },
}));
const inventory = { name: 'My bricks.csv', source: 'upload' as const, parts: [{ part_id: '3001', color_id: 4, quantity: 3 }] };
let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { vi.useFakeTimers(); element = document.createElement('div'); document.body.append(element); root = createRoot(element); });
afterEach(() => { act(() => root.unmount()); element.remove(); vi.useRealTimers(); vi.clearAllMocks(); });
const render = (select = vi.fn()) => { act(() => root.render(<ExistingPartsDesigner onSelect={select} onBack={vi.fn()} />)); return select; };
const inputValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

it('uploads a parts file and returns the exact parsed inventory to the composer', async () => {
  vi.mocked(PartsInventoryApi.upload).mockResolvedValue({ inventory, unavailable: [] });
  const select = render();
  const input = element.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [new File(['parts'], inventory.name)] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(select).toHaveBeenCalledWith(inventory);
  expect(input.accept).toContain('.io');
});

it('keeps upload errors visible without selecting a partial inventory', async () => {
  vi.mocked(PartsInventoryApi.upload).mockRejectedValue(new Error('Invalid quantity'));
  const select = render();
  const input = element.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [new File(['bad'], 'bad.csv')] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(element.querySelector('[role=alert]')?.textContent).toContain('Invalid quantity');
  expect(select).not.toHaveBeenCalled();
});

it('searches sets and requires an explicit choice when some pieces are unavailable', async () => {
  vi.mocked(PartsInventoryApi.search).mockResolvedValue([{ set_num: '123-1', name: 'Brick box', year: 2020, num_parts: 5 }]);
  vi.mocked(PartsInventoryApi.select).mockResolvedValue({ inventory, unavailable: [{ part_id: 'unknown', color_id: 4, quantity: 2 }] });
  const select = render();
  act(() => inputValue(element.querySelector('input[aria-label="Search LEGO sets"]')!, '123'));
  await act(async () => { vi.advanceTimersByTime(300); });
  await act(async () => element.querySelector<HTMLButtonElement>('.existing-parts-results button')!.click());
  expect(select).not.toHaveBeenCalled();
  expect(element.textContent).toContain('2 pieces have no exact');
  act(() => element.querySelector<HTMLButtonElement>('.existing-parts-use')!.click());
  expect(select).toHaveBeenCalledWith(inventory);
});

it('offers manual upload when a set is absent', async () => {
  vi.mocked(PartsInventoryApi.search).mockResolvedValue([]);
  render();
  act(() => inputValue(element.querySelector('input[aria-label="Search LEGO sets"]')!, 'Missing'));
  await act(async () => { vi.advanceTimersByTime(300); });
  expect(element.textContent).toContain('Download a parts list from Rebrickable or BrickLink');
});

it('aborts an upload when leaving the screen', async () => {
  vi.mocked(PartsInventoryApi.upload).mockImplementation(() => new Promise(() => {}));
  render();
  const input = element.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [new File(['parts'], 'parts.csv')] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  const signal = vi.mocked(PartsInventoryApi.upload).mock.calls[0][1]!;
  act(() => root.render(null));
  expect(signal.aborted).toBe(true);
});
