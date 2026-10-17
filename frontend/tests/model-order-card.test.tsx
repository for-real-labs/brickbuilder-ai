import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelOrderCard } from '../src/components/ModelOrderCard';
import { MobileModelOrderBar } from '../src/components/MobileModelOrderBar';
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
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Order my kit"]')!.click());
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Order this model"]')!.click());
  expect(order.mock.calls).toEqual([['card'], ['mobile_bar']]);
});

it.each(['loading', 'updating', 'error', 'missing', 'invalid'])('blocks purchases when %s without creating a zero price order', state => {
  const order = vi.fn();
  act(() => root.render(<ModelOrderCard quote={state === 'missing' ? null : state === 'invalid' ? {...quote, total_price: NaN} : quote}
    loading={state === 'loading'} updating={state === 'updating'} error={state === 'error' ? 'Pricing failed' : null} onOrder={order} />));
  for (const button of container.querySelectorAll<HTMLButtonElement>('button:not([aria-label="Dismiss order banner"])')) {
    expect(button.disabled).toBe(true);
    act(() => button.click());
  }
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Dismiss order banner"]')!.disabled).toBe(false);
  expect(order).not.toHaveBeenCalled();
  if (state === 'missing' || state === 'invalid') expect(container.textContent).toContain('Price unavailable right now.');
});

it('dismisses the mobile banner while keeping the full order card available', () => {
  const order = vi.fn(), dismiss = vi.fn();
  act(() => root.render(<ModelOrderCard quote={quote} loading={false} updating={false} error={null} onOrder={order} onMobileDismiss={dismiss} />));
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Dismiss order banner"]')!.click());
  expect(container.querySelector('.model-mobile-order')).toBeNull();
  expect(container.querySelector('.model-order-card')).not.toBeNull();
  expect(dismiss).toHaveBeenCalledOnce();
  expect(order).not.toHaveBeenCalled();
});

it('reports the banner height and releases the reserved space when hidden or unmounted', () => {
  let notify!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const height = vi.fn();
  try {
    act(() => root.render(<MobileModelOrderBar quote={quote} loading={false} updating={false} error={null}
      onOrder={vi.fn()} onDismiss={vi.fn()} onHeightChange={height} />));
    const banner = container.querySelector('.model-mobile-order')!;
    const bounds = vi.spyOn(banner, 'getBoundingClientRect').mockReturnValue({ height: 102 } as DOMRect);
    act(() => notify());
    expect(height).toHaveBeenLastCalledWith(102);
    bounds.mockReturnValue({ height: 0 } as DOMRect);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(height).toHaveBeenLastCalledWith(0);
    act(() => root.render(null));
    expect(disconnect).toHaveBeenCalledOnce();
    expect(height).toHaveBeenLastCalledWith(0);
  } finally { vi.unstubAllGlobals(); }
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

it('shows the total piece count instead of shipping copy in the compact order bar', () => {
  act(() => root.render(<MobileModelOrderBar quote={{ ...quote, total_parts: 1234 }} loading={false} updating={false}
    error={null} onOrder={vi.fn()} onDismiss={vi.fn()} showOnDesktop />));
  expect(container.querySelector('.model-mobile-order span')?.textContent).toBe('1,234 pieces');
  expect(container.textContent).not.toContain('Shipping included');
  expect(container.querySelector('.model-mobile-order--all-screens')).not.toBeNull();
});
