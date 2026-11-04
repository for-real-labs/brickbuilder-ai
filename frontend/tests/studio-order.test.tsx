import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ price: vi.fn(), navigate: vi.fn(), redirect: vi.fn() }));
vi.mock('react-router-dom', () => ({
  Navigate: (props: unknown) => { mocks.redirect(props); return null; },
  useNavigate: () => mocks.navigate,
}));
vi.mock('../src/contexts/AuthContext', () => ({ useAuth: () => ({ session: { access_token: 'test-token' } }) }));
vi.mock('../src/services/getPriceApi', () => ({ GetPriceApiService: { getPrice: mocks.price } }));
vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
import { ImportedStudioOrder } from '../src/components/ImportedStudioOrder';
import { LandingModelOrdering } from '../src/components/LandingModelOrdering';
import type { LandingModel } from '../src/hooks/useLandingModel';

it('sends Studio’s order handoff to the same pricing and conversion flow', async () => {
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<ImportedStudioOrder id="model-123" />));
    expect(mocks.redirect).toHaveBeenCalledWith({ to: '/?id=model-123&exact=1', replace: true });
  } finally {
    act(() => root.unmount());
  }
});

it('checks imported parts before enabling Order and asks before starting a paid conversion', async () => {
  let resolve!: (value: unknown) => void;
  mocks.price.mockReturnValue(new Promise(done => { resolve = done; }));
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value: vi.fn() },
    close: { configurable: true, value: vi.fn() },
  });
  const onConvert = vi.fn();
  const node = document.createElement('div');
  document.body.append(node);
  const root = createRoot(node);
  try {
    const model = { generation: { generation_id: 'model-123', endpoint: 'uploadLdraw' } } as LandingModel;
    await act(async () => root.render(<LandingModelOrdering model={model} busy={false} showMobileBar
      onDismiss={() => {}} onConvert={onConvert} />));
    const order = node.querySelector<HTMLButtonElement>('[aria-label="Order my kit"]')!;
    expect(order.disabled).toBe(true);
    expect(node.textContent).toContain('Pricing…');
    await act(async () => resolve({ conversion_credits: 20, total_parts: 1, total_price: 0, total_weight: 0 }));
    expect(order.disabled).toBe(false);
    act(() => order.click());
    const dialog = document.querySelector('dialog')!;
    expect(dialog.textContent).toContain('Some parts aren’t in our inventory');
    expect(onConvert).not.toHaveBeenCalled();
    act(() => dialog.querySelector<HTMLButtonElement>('.kit-conversion-cancel')!.click());
    expect(onConvert).not.toHaveBeenCalled();
    act(() => order.click());
    const confirm = document.querySelector<HTMLButtonElement>('dialog .model-order-button')!;
    expect(confirm.textContent).toContain('Convert for 20 credits');
    act(() => confirm.click());
    expect(onConvert).toHaveBeenCalledOnce();
    expect(mocks.navigate).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    node.remove();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  }
});
