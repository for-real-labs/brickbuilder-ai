import * as IAP from 'expo-iap';

export const CREDIT_PRODUCTS = ['ai.brickbuilder.app.credits.800', 'ai.brickbuilder.app.credits.1500'];
export const APPLE_PRODUCTS = ['ai.brickbuilder.app.builder.monthly', 'ai.brickbuilder.app.creator.monthly', ...CREDIT_PRODUCTS];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APPLE_EVENT = 'brickbuilder:apple-purchases';

type Emit = (detail: object) => void;

/** Origin-bound bridge; transactions finish only after the authenticated server grants credits. */
export class ApplePurchases {
  private purchases = new Map<string, IAP.Purchase>();
  private connection: Promise<boolean> | undefined;
  private listeners: { remove(): void }[] = [];
  constructor(private emit: Emit, private origin: string) {}

  private connect() {
    if (!this.connection) {
      this.listeners = [
        IAP.purchaseUpdatedListener(purchase => {
          if (!APPLE_PRODUCTS.includes(purchase.productId)) return;
          this.purchases.set(purchase.id, purchase);
          this.emit({ transaction: purchase.id });
        }),
        IAP.purchaseErrorListener(error => this.emit({ error: error.code === 'user-cancelled'
          ? 'Purchase canceled. You have not been charged.' : 'Purchase could not finish. Check your Apple account or try Restore purchases.' })),
      ];
      this.connection = IAP.initConnection().catch(error => {
        this.listeners.forEach(listener => listener.remove()); this.listeners = []; this.connection = undefined;
        throw error;
      });
    }
    return this.connection;
  }

  async handle(raw: string, url: string) {
    let message: Record<string, unknown>;
    try {
      if (new URL(url).origin !== this.origin || raw.length > 2000) return;
      message = JSON.parse(raw);
      if (message?.type !== APPLE_EVENT || typeof message.id !== 'string' || message.id.length > 80) return;
    } catch { return; }
    const { id, action } = message;
    try {
      if (!await this.connect()) throw new Error('Store unavailable');
      let result: unknown = null;
      if (action === 'products') {
        const products = await IAP.fetchProducts({ skus: APPLE_PRODUCTS, type: 'all' });
        result = (products ?? []).filter(p => APPLE_PRODUCTS.includes(p.id)).map(p => ({ id: p.id, displayPrice: p.displayPrice }));
      } else if (action === 'buy') {
        if (typeof message.product !== 'string' || !APPLE_PRODUCTS.includes(message.product)
            || typeof message.accountToken !== 'string' || !UUID.test(message.accountToken)) throw new Error('Invalid purchase');
        await IAP.requestPurchase({ type: CREDIT_PRODUCTS.includes(message.product) ? 'in-app' : 'subs', request: { apple: { sku: message.product,
          appAccountToken: message.accountToken, andDangerouslyFinishTransactionAutomatically: false } } });
      } else if (action === 'restore' || action === 'pending') {
        // StoreKit maintains verified current entitlements automatically. Avoid
        // forcing an Apple login when the purchase is already on this device;
        // the backend still verifies ownership and current subscription state.
        let purchases = [...await IAP.getAvailablePurchases(), ...await IAP.getPendingTransactionsIOS()].filter(p => APPLE_PRODUCTS.includes(p.productId));
        if (action === 'restore' && purchases.length === 0) {
          await IAP.syncIOS();
          purchases = (await IAP.getAvailablePurchases()).filter(p => APPLE_PRODUCTS.includes(p.productId));
        }
        result = [...new Map(purchases.map(p => [p.id, p])).values()].map(p => {
          this.purchases.set(p.id, p); return p.id;
        });
      } else if (action === 'finish') {
        const transaction = String(message.transaction);
        if (this.purchases.has(transaction)) {
          // Restored entitlements can already be finished. Only acknowledge an
          // unfinished transaction, using StoreKit's current pending payload.
          const pending = await IAP.getPendingTransactionsIOS();
          const purchase = pending.find(p => p.id === transaction && APPLE_PRODUCTS.includes(p.productId));
          if (purchase) await IAP.finishTransaction({ purchase, isConsumable: CREDIT_PRODUCTS.includes(purchase.productId) });
          this.purchases.delete(transaction);
        }
      } else if (action === 'manage') {
        await IAP.showManageSubscriptionsIOS();
      } else { return; }
      this.emit({ id, result });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        && typeof error.code === 'string' && /^[a-z0-9-]{1,60}$/i.test(error.code) ? error.code : 'unknown';
      this.emit({ id, error: `Apple could not complete ${action === 'restore' ? 'the restore' : action === 'finish' ? 'transaction confirmation' : 'this request'} (${code}). Please try again.` });
    }
  }

  dispose() {
    this.listeners.forEach(listener => listener.remove());
    if (this.connection) void this.connection.then(() => IAP.endConnection()).catch(() => {});
  }
}

export function appleDispatchScript(detail: object, origin: string) {
  return `if (window.location.origin === ${JSON.stringify(origin)}) window.dispatchEvent(new CustomEvent(${JSON.stringify(APPLE_EVENT)}, {detail: ${JSON.stringify(detail)}})); true;`;
}
