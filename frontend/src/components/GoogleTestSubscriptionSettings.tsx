import React, { useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../contexts/AuthContext';
import { googleTestSubscription } from '../services/googleTestSubscription';

export function GoogleTestSubscriptionSettings() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (user?.app_metadata?.google_subscription_test !== true) return null;

  async function reset() {
    setBusy(true);
    setMessage('');
    posthog.capture('billing_test_subscription_reset_clicked');
    try {
      await googleTestSubscription.reset();
      setMessage('Sandbox subscription reset. You can start a new checkout.');
    } catch {
      setMessage('Could not reset the sandbox subscription. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="mb-4 rounded-xl border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="google-test-subscription-heading">
    <h2 id="google-test-subscription-heading" className="font-bold text-slate-900">Test subscription</h2>
    <p className="mt-1 text-sm text-slate-600">Cancel sandbox subscriptions and close pending test checkouts for this account.</p>
    <button type="button" className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-60" disabled={busy}
      onClick={() => void reset()}>{busy ? 'Resetting…' : 'Reset sandbox subscription'}</button>
    {message && <p className="mt-2 text-sm" role="status">{message}</p>}
  </section>;
}
