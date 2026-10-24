import { beforeEach, expect, it, vi } from 'vitest';
import * as IAP from 'expo-iap';
import { ApplePurchases, APPLE_EVENT, APPLE_PRODUCTS, appleDispatchScript } from '../src/applePurchases';
vi.mock('expo-iap', () => ({
  initConnection: vi.fn(async () => true), endConnection: vi.fn(),
  purchaseUpdatedListener: vi.fn(() => ({ remove: vi.fn() })), purchaseErrorListener: vi.fn(() => ({ remove: vi.fn() })),
  fetchProducts: vi.fn(async () => [{ id: 'ai.brickbuilder.app.builder.monthly', displayPrice: '€9.99' }]),
  requestPurchase: vi.fn(), finishTransaction: vi.fn(), getAvailablePurchases: vi.fn(async () => []),
  getPendingTransactionsIOS: vi.fn(async () => []),
  syncIOS: vi.fn(), showManageSubscriptionsIOS: vi.fn(),
}));
const origin = 'https://brickbuilder.ai';
const message = (action: string, fields = {}) => JSON.stringify({ type: APPLE_EVENT, id: 'request', action, ...fields });
beforeEach(() => vi.clearAllMocks());
it('rejects untrusted origins and unrecognized products before opening payment', async () => {
  const emit = vi.fn(); const bridge = new ApplePurchases(emit, origin);
  await bridge.handle(message('products'), 'https://checkout.stripe.com');
  expect(IAP.initConnection).not.toHaveBeenCalled();
  await bridge.handle(message('buy', { product: 'other', accountToken: 'x' }), origin);
  expect(IAP.requestPurchase).not.toHaveBeenCalled();
});
it('returns store-localized pricing and binds purchase to the account UUID', async () => {
  const emit=vi.fn(); const bridge=new ApplePurchases(emit,origin);
  await bridge.handle(message('products'), origin);
  expect(emit).toHaveBeenCalledWith({ id: 'request', result: [{ id: APPLE_PRODUCTS[0], displayPrice: '€9.99' }] });
  const token='00000000-0000-4000-8000-000000000001';
  await bridge.handle(message('buy', { product: APPLE_PRODUCTS[0], accountToken: token }),origin);
  expect(IAP.requestPurchase).toHaveBeenCalledWith({ type: 'subs', request: { apple: {
    sku: APPLE_PRODUCTS[0], appAccountToken: token, andDangerouslyFinishTransactionAutomatically: false,
  } } });
  expect(IAP.finishTransaction).not.toHaveBeenCalled();
});
it('keeps restored transactions unfinished until the web server confirms delivery', async () => {
  const purchase={id:'123',productId:APPLE_PRODUCTS[0]} as IAP.Purchase;
  vi.mocked(IAP.getAvailablePurchases).mockResolvedValueOnce([purchase]);
  vi.mocked(IAP.getPendingTransactionsIOS).mockResolvedValueOnce([purchase as IAP.PurchaseIOS]);
  const emit=vi.fn(); const bridge=new ApplePurchases(emit,origin);
  await bridge.handle(message('restore'),origin);
  expect(IAP.syncIOS).toHaveBeenCalledOnce();
  expect(emit).toHaveBeenCalledWith({id:'request',result:['123']});
  expect(IAP.finishTransaction).not.toHaveBeenCalled();
  await bridge.handle(message('finish',{transaction:'123'}),origin);
  expect(IAP.finishTransaction).toHaveBeenCalledWith({purchase,isConsumable:false});
  expect(appleDispatchScript({transaction:'123'},origin)).toContain('window.location.origin === "https://brickbuilder.ai"');
});

it('does not finish a restored entitlement that Apple has already finished', async () => {
  const purchase={id:'456',productId:APPLE_PRODUCTS[0]} as IAP.Purchase;
  vi.mocked(IAP.getAvailablePurchases).mockResolvedValueOnce([purchase]);
  const emit=vi.fn(); const bridge=new ApplePurchases(emit,origin);
  await bridge.handle(message('restore'),origin);
  await bridge.handle(message('finish',{transaction:'456'}),origin);
  expect(IAP.getPendingTransactionsIOS).toHaveBeenCalledOnce();
  expect(IAP.finishTransaction).not.toHaveBeenCalled();
  expect(emit).toHaveBeenLastCalledWith({id:'request',result:null});
});

it('retains an unfinished transaction when acknowledgement fails so it can retry', async () => {
  const purchase={id:'789',productId:APPLE_PRODUCTS[0]} as IAP.PurchaseIOS;
  vi.mocked(IAP.getAvailablePurchases).mockResolvedValueOnce([purchase]);
  vi.mocked(IAP.getPendingTransactionsIOS).mockResolvedValueOnce([purchase]).mockResolvedValueOnce([purchase]);
  vi.mocked(IAP.finishTransaction).mockRejectedValueOnce({code:'service-error'});
  const emit=vi.fn(); const bridge=new ApplePurchases(emit,origin);
  await bridge.handle(message('restore'),origin);
  await bridge.handle(message('finish',{transaction:'789'}),origin);
  expect(emit).toHaveBeenLastCalledWith({id:'request',error:expect.stringContaining('transaction confirmation (service-error)')});
  await bridge.handle(message('finish',{transaction:'789'}),origin);
  expect(IAP.finishTransaction).toHaveBeenCalledTimes(2);
  expect(emit).toHaveBeenLastCalledWith({id:'request',result:null});
});
