import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelOrderCard } from '../src/components/ModelOrderCard';
import type { GetPriceResponse } from '../src/services/getPriceApi';

const quote = {total_price: 44.77, total_weight: .5263, total_parts: 370, currency: 'USD', parts_breakdown: []} as unknown as GetPriceResponse;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement('div'); root = createRoot(container); });
afterEach(() => act(() => root.unmount()));

it('uses the checkout cent rounding and launch discount with shipping included', () => {
  const order = vi.fn();
  act(() => root.render(<ModelOrderCard quote={quote} loading={false} updating={false} error={null} onOrder={order} />));
  expect(container.querySelector('.model-order-total')?.textContent).toBe('$22.39');
  expect(container.querySelector('.model-order-original')?.textContent).toBe('$44.77');
  expect(container.textContent).toContain('BrickBuilder Launch Discount');
  expect(container.textContent).toContain('8–12 business days');
  const buttons = container.querySelectorAll('button');
  act(() => buttons[0].click());
  act(() => buttons[1].click());
  expect(order.mock.calls).toEqual([['card'], ['mobile_bar']]);
});

it.each(['loading', 'updating', 'error', 'missing', 'invalid'])('blocks purchases when %s without creating a zero price order', state => {
  const order = vi.fn();
  act(() => root.render(<ModelOrderCard quote={state === 'missing' ? null : state === 'invalid' ? {...quote, total_price: NaN} : quote}
    loading={state === 'loading'} updating={state === 'updating'} error={state === 'error' ? 'Pricing failed' : null} onOrder={order} />));
  for (const button of container.querySelectorAll('button')) {
    expect(button.disabled).toBe(true);
    act(() => button.click());
  }
  expect(order).not.toHaveBeenCalled();
  if (state === 'missing' || state === 'invalid') expect(container.textContent).toContain('Price unavailable right now.');
});

it('offers sizing separately from purchasing and locks it while the model updates', () => {
  const resize = vi.fn(), order = vi.fn();
  const render = (updating: boolean) => act(() => root.render(<ModelOrderCard quote={quote} loading={false}
    updating={updating} error={null} onOrder={order} onResize={resize} />));
  render(false);
  act(() => (container.querySelector('.model-resize-link') as HTMLButtonElement).click());
  expect(resize).toHaveBeenCalledOnce();
  expect(order).not.toHaveBeenCalled();
  render(true);
  expect((container.querySelector('.model-resize-link') as HTMLButtonElement).disabled).toBe(true);
});
