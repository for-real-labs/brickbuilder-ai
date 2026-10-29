import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreviousOrderParts } from '../src/components/PreviousOrderParts';
import { GetUserGenerationsApiService } from '../src/services/getUserGenerationsApi';
import { PartsInventoryApi } from '../src/services/partsInventoryApi';
const auth = vi.hoisted(() => ({ session: { user: { id: 'owner' }, access_token: 'token' } as any, loading: false }));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('../src/services/getUserGenerationsApi', () => ({ GetUserGenerationsApiService: { getUserGenerations: vi.fn() } }));
vi.mock('../src/services/partsInventoryApi', () => ({ PartsInventoryApi: { order: vi.fn() }, inventoryQuantity: (value: any) => value.parts.reduce((n: number, p: any) => n + p.quantity, 0) }));
const generation = { id: 'model-1', name: 'Red car', prompt: 'car', status: 'completed', endpoint: 'novaToBricks', preview_image_url: 'https://example.com/car.png' };
const order = { id: 42, generation_id: 'model-1', prompt: 'car' };
const inventory = { name: 'Red car (Order #42)', source: 'order' as const, parts: [{ part_id: '3001', color_id: 4, quantity: 8 }] };
const page = (orders: any[] = [order], generations: any[] = [generation], has_more = false): any => ({ all_orders: orders, generations, has_more });
let element: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const select = vi.fn(); const login = vi.fn();
const render = () => act(() => root.render(<PreviousOrderParts onSelect={select} onLogin={login} />));
const click = async (text: string) => act(async () => {
  const button = [...element.querySelectorAll('button')].find(node => node.textContent?.includes(text));
  expect(button).toBeTruthy(); button!.click();
});
beforeEach(() => {
  vi.clearAllMocks(); auth.session = { user: { id: 'owner' }, access_token: 'token' };
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue(page());
  vi.mocked(PartsInventoryApi.order).mockResolvedValue({ inventory, unavailable: [] });
});
afterEach(() => { act(() => root.unmount()); element.remove(); });
it('loads on demand, previews a selected order and confirms its exact inventory', async () => {
  render(); expect(GetUserGenerationsApiService.getUserGenerations).not.toHaveBeenCalled();
  await click('Your previous orders');
  expect(element.querySelector('img')?.getAttribute('src')).toBe(generation.preview_image_url);
  await click('Red car');
  expect(element.querySelector('a')?.getAttribute('href')).toBe('/?id=model-1&exact=1');
  expect(select).not.toHaveBeenCalled();
  await click('Use these 8 parts'); expect(select).toHaveBeenCalledWith(inventory);
});
it('offers order links for completed generations when no non-cancelled orders exist', async () => {
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue(page([{ ...order, cancelled: true }], [generation, { ...generation, id: 'pending', status: 'processing' }]));
  render(); await click('Your previous orders');
  expect(element.textContent).toContain('Make an order on brickbuilder.ai first');
  expect(element.querySelector('ul')?.getAttribute('aria-label')).toBe('Your previous generations');
  expect(element.querySelectorAll('li')).toHaveLength(1);
  expect(element.querySelector('a')?.getAttribute('href')).toBe('/order?id=model-1');
});
it('paginates generations without showing duplicates', async () => {
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValueOnce(page([], [generation], true)).mockResolvedValueOnce(page([], [generation, { ...generation, id: 'older' }]));
  render(); await click('Your previous orders'); await click('Show more generations');
  expect(GetUserGenerationsApiService.getUserGenerations).toHaveBeenLastCalledWith('token', 30, 1, false, expect.any(AbortSignal), false);
  expect(element.querySelectorAll('li')).toHaveLength(2);
});
it('does not claim there are no orders on a failed request and offers retry', async () => {
  vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockRejectedValueOnce(new Error('offline'));
  render(); await click('Your previous orders');
  expect(element.textContent).not.toContain('Make an order');
  await click('Try again'); expect(element.textContent).toContain('Red car');
});
it('keeps the preview but blocks use when the ordered parts list is missing', async () => {
  vi.mocked(PartsInventoryApi.order).mockRejectedValue(new Error('Upload its original parts list instead.'));
  render(); await click('Your previous orders'); await click('Red car');
  expect(element.textContent).toContain('Upload its original'); expect(element.textContent).toContain('View model');
  expect(element.textContent).not.toContain('Use these'); expect(select).not.toHaveBeenCalled();
});
it('clears account data and aborts pending inventory requests on account changes', async () => {
  vi.mocked(PartsInventoryApi.order).mockImplementation(() => new Promise(() => {}));
  render(); await click('Your previous orders'); await click('Red car');
  const signal = vi.mocked(PartsInventoryApi.order).mock.calls[0][1]!;
  auth.session = { user: { id: 'different' }, access_token: 'new-token' }; render();
  expect(signal.aborted).toBe(true); expect(element.textContent).not.toContain('Red car');
});
it('offers sign in for guests without hiding upload or set alternatives', async () => {
  auth.session = null; vi.mocked(GetUserGenerationsApiService.getUserGenerations).mockResolvedValue(page([], []));
  render(); await click('Your previous orders'); await click('Sign in'); expect(login).toHaveBeenCalled();
  expect(element.textContent).toContain('existing set or upload a parts list below');
});
