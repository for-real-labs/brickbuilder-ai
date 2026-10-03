import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ options: null as any, paymentOptions: null as any, state: null as any, ready: null as any, load: vi.fn().mockResolvedValue(null), confirm: vi.fn() }));
vi.mock('@stripe/stripe-js', () => ({loadStripe: mocks.load}));
vi.mock('@stripe/react-stripe-js/checkout', () => ({
  CheckoutElementsProvider: ({options, children}: any) => { mocks.options = options; return children; },
  ShippingAddressElement: () => <div>Address fields</div>,
  PaymentElement: ({onReady, options}: any) => { mocks.paymentOptions = options; mocks.ready = onReady; return <div>Card fields</div>; },
  useCheckoutElements: () => mocks.state,
}));
vi.mock('posthog-js', () => ({default:{capture:vi.fn()}}));
beforeEach(() => {
  mocks.confirm.mockReset();
  mocks.load.mockResolvedValue(null);
  mocks.state = {type:'success',checkout:{total:{total:{amount:'$15.00'}},confirm:mocks.confirm}};
  vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', 'pk_test_fake');
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

async function renderCheckout(withKey = true) {
  vi.stubEnv('VITE_STRIPE_PUBLISHABLE_KEY', withKey ? 'pk_test_fake' : '');
  const { EmbeddedOrderCheckout } = await import('../src/components/EmbeddedOrderCheckout');
  const container = document.createElement('div');
  const root = createRoot(container);
  const done = vi.fn();
  act(() => root.render(<EmbeddedOrderCheckout clientSecret="secret" generationId="model" onComplete={done} />));
  return {container, root, done};
}

it('mounts individual Elements with the session secret and matching appearance', async () => {
  const {container,root} = await renderCheckout();
  try {
    expect(mocks.options.clientSecret).toBe('secret');
    expect(mocks.options.elementsOptions.appearance.variables.colorPrimary).toBe('#ef493f');
    expect(container.textContent).toContain('Address fields');
    expect(container.textContent).toContain('Card fields');
    expect(mocks.paymentOptions.layout).toEqual({type:'accordion',defaultCollapsed:false});
    expect(mocks.paymentOptions.paymentMethodOrder).toEqual(['card']);
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    act(() => mocks.ready());
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  } finally { act(() => root.unmount()); }
});

it('confirms payment with email and calls completion only on success', async () => {
  mocks.confirm.mockResolvedValue({type:'success',session:{status:'complete'}});
  const {container,root,done} = await renderCheckout();
  try {
    act(() => {
      mocks.ready();
      const input = container.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'buyer@example.com');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(mocks.confirm).toHaveBeenCalledWith({email:'buyer@example.com',redirect:'if_required'});
    expect(done).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
});

it('shows a declined payment and allows retry without completing the order', async () => {
  mocks.confirm.mockResolvedValue({type:'error',error:{message:'Your card was declined.'}});
  const {container,root,done} = await renderCheckout();
  try {
    act(() => mocks.ready());
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Your card was declined.');
    expect(done).not.toHaveBeenCalled();
    expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  } finally { act(() => root.unmount()); }
});

it('prevents duplicate confirmations while payment is pending', async () => {
  let resolve: (value:any) => void = () => {};
  mocks.confirm.mockReturnValue(new Promise(done => {resolve=done;}));
  const {container,root} = await renderCheckout();
  try {
    act(() => mocks.ready());
    act(() => {
      container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
      container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(container.querySelector('button')?.textContent).toBe('Processing payment…');
    expect(mocks.paymentOptions.readOnly).toBe(true);
    await act(async () => resolve({type:'error',error:{message:'Try again'}}));
  } finally { act(() => root.unmount()); }
});

it.each(['loading','error'])('shows the %s state without a pay button', async type => {
  mocks.state={type,error:{message:'Unavailable'}};
  const {container,root} = await renderCheckout();
  try {
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector(type === 'loading' ? '[role="status"]' : '[role="alert"]')).not.toBeNull();
  } finally {act(() => root.unmount());}
});

it('shows a helpful error when the publishable key is missing', async () => {
  const {container,root} = await renderCheckout(false);
  try { expect(container.querySelector('[role="alert"]')?.textContent).toContain('Payment setup is unavailable'); }
  finally { act(() => root.unmount()); }
});
