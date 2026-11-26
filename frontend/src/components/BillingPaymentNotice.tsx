import React, { useEffect, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { useBilling } from '../contexts/BillingContext';
import { billingApi, type FailedPayment } from '../services/billingApi';

export function BillingPaymentNotice() {
  const { user } = useAuth();
  const { account } = useBilling();
  const overdue = account?.subscription_provider === 'stripe' && ['past_due', 'unpaid'].includes(account.subscription_status);
  return user && overdue ? <OutstandingPayment key={user.id + ":" + (account.payment_status_version ?? account.subscription_status)} /> : null;
}

function OutstandingPayment() {
  const { pathname } = useLocation();
  const [payment, setPayment] = useState<FailedPayment | null>(null);
  useEffect(() => {
    let active = true;
    void billingApi.failedPayment().then(result => { if (active) setPayment(result); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const amount = payment && new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(payment.amount_due_cents / 100);
  return <aside aria-label="Subscription payment" className="sticky top-0 z-[90] border-b border-amber-300 bg-amber-50 text-amber-950">
    <div className="mx-auto flex max-w-7xl flex-col items-start sm:flex-row sm:items-center gap-x-4 gap-y-1 px-4 py-2">
      <div role="alert" className="flex min-w-0 flex-1 items-start gap-2 text-sm leading-5">
        <CircleAlert aria-hidden="true" size={18} className="mt-px shrink-0" />
        <p><strong>Your{amount && ` ${amount}`} subscription payment failed.</strong>{' '}
          {payment?.card_declined && 'Your card was declined. '}Check your payment method in billing.</p>
      </div>
      {pathname !== '/billing' && <Link to="/billing" className="inline-flex min-h-11 items-center font-semibold underline underline-offset-2"
        onClick={() => posthog.capture('billing_payment_notice_clicked', { source: pathname })}>Review billing</Link>}
    </div>
  </aside>;
}
