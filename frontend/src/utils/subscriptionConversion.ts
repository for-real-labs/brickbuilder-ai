export function pushSubscriptionConversion(transactionId: string): void {
  const page = window as Window & { dataLayer?: unknown[] };
  (page.dataLayer ??= []).push({ event: 'subscription_confirmed', transaction_id: transactionId });
}
