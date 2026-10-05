import React from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { CheckoutElementsProvider, PaymentElement, ShippingAddressElement, useCheckoutElements } from '@stripe/react-stripe-js/checkout';
import posthog from 'posthog-js';

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
const stripePromise = publishableKey ? loadStripe(publishableKey, { developerTools: { assistant: { enabled: false } } }) : null;

type OrderCheckoutProps = {
  clientSecret: string;
  generationId?: string;
  onComplete: () => void;
};

function OrderPaymentForm({ generationId, onComplete }: Omit<OrderCheckoutProps, 'clientSecret'>) {
  const checkoutState = useCheckoutElements();
  const [email, setEmail] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const submissionInProgress = React.useRef(false);

  if (checkoutState.type === 'loading') return <p role="status" className="py-6 text-sm text-slate-500">Loading payment options…</p>;
  if (checkoutState.type === 'error') return <p role="alert" className="py-6 text-sm text-red-700">Couldn't load payment options. Refresh the page to try again.</p>;
  const { checkout } = checkoutState;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || submissionInProgress.current) return;
    submissionInProgress.current = true;
    setSubmitting(true);
    setError(null);
    posthog.capture('order_payment_submitted', { generation_id: generationId });
    try {
      const result = await checkout.confirm({ email: email.trim(), redirect: 'if_required' });
      if (result.type === 'error') {
        setError(result.error.message);
        posthog.capture('order_payment_failed', { generation_id: generationId });
      } else {
        onComplete();
      }
    } catch {
      setError('Could not complete your payment. Please try again.');
      posthog.capture('order_payment_failed', { generation_id: generationId });
    } finally {
      submissionInProgress.current = false;
      setSubmitting(false);
    }
  };

  const elementError = () => setError('Could not load the payment form. Refresh the page to try again.');
  return (
    <form onSubmit={submit} className="space-y-6" aria-label="Complete your order">
      <div>
        <label htmlFor="order-email" className="mb-2 block text-sm font-medium">Email</label>
        <input id="order-email" type="email" autoComplete="email" required value={email} disabled={submitting} onChange={event => setEmail(event.target.value)} className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base focus:border-[#ef493f] focus:outline-none focus:ring-2 focus:ring-red-100" placeholder="you@example.com" />
      </div>
      <div><h3 className="mb-3 text-sm font-medium">Shipping address</h3><ShippingAddressElement onLoadError={elementError} /></div>
      <div><h3 className="mb-3 text-sm font-medium">Payment</h3><PaymentElement options={{ layout: { type: 'accordion', defaultCollapsed: false }, paymentMethodOrder: ['card'], readOnly: submitting }} onReady={() => setReady(true)} onLoadError={elementError} /></div>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={!ready || submitting} className="flex min-h-14 w-full items-center justify-center rounded-xl bg-[#ef493f] px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#d83930] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#ef493f] disabled:cursor-not-allowed disabled:bg-slate-300">
        {submitting ? 'Processing payment…' : `Pay ${checkout.total.total.amount}`}
      </button>
    </form>
  );
}

export function EmbeddedOrderCheckout({ clientSecret, generationId, onComplete }: OrderCheckoutProps) {
  const options = React.useMemo(() => ({
    clientSecret,
    elementsOptions: {
      appearance: {
        variables: {
          colorPrimary: '#ef493f', colorBackground: '#ffffff', colorText: '#0f172a',
          colorDanger: '#b91c1c', fontFamily: 'system-ui, sans-serif', borderRadius: '12px', spacingUnit: '4px',
        },
      },
    },
  }), [clientSecret]);
  if (!stripePromise) return <p role="alert" className="text-sm text-red-600">Payment setup is unavailable. Please try again later.</p>;

  return (
    <section aria-label="Payment and shipping" className="mt-6 min-w-0">
      <CheckoutElementsProvider stripe={stripePromise} options={options}>
        <OrderPaymentForm generationId={generationId} onComplete={onComplete} />
      </CheckoutElementsProvider>
    </section>
  );
}
