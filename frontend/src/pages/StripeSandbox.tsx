import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { pushSubscriptionConversion } from '../utils/subscriptionConversion';

const prefix = '/stripe-sandbox';

async function request(path: string) {
  const result = await fetch(prefix + path, { method: 'POST' });
  if (!result.ok) throw new Error('The Stripe sandbox is unavailable. Try again.');
  return result.json();
}

export default function StripeSandbox() {
  const sessionId = new URLSearchParams(window.location.search).get('session_id');
  const [busy, setBusy] = useState(false);
  const [transactionId, setTransactionId] = useState('');
  const [message, setMessage] = useState('');

  async function confirm() {
    if (!sessionId) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request(`/sync?session_id=${encodeURIComponent(sessionId)}`);
      if (result.transaction_id) {
        pushSubscriptionConversion(result.transaction_id);
        setTransactionId(result.transaction_id);
        const url = new URL(window.location.href);
        url.searchParams.delete('session_id');
        url.searchParams.delete('checkout');
        window.history.replaceState(null, '', url);
      } else {
        setMessage('Stripe has not confirmed the test payment yet.');
      }
    } catch {
      setMessage('The Stripe sandbox is unavailable. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    setBusy(true);
    setMessage('');
    try {
      const result = await request('/checkout');
      window.location.assign(result.url);
    } catch {
      setMessage('The Stripe sandbox is unavailable. Try again.');
      setBusy(false);
    }
  }

  useEffect(() => { void confirm(); }, []);

  return <main className="mx-auto max-w-lg px-5 py-12 text-slate-950">
    <Helmet><title>Stripe sandbox | BrickBuilder</title><meta name="robots" content="noindex, nofollow" /></Helmet>
    <h1 className="mb-4 text-3xl font-bold">BrickBuilder Stripe sandbox</h1>
    <p className="mb-4">This checkout uses Stripe test payments. No charge.</p>
    {transactionId && <p className="mb-4 break-all" role="status">Stripe confirmed the test payment. Sent <code>subscription_confirmed</code> with transaction ID <code>{transactionId}</code>.</p>}
    {message && <p className="mb-4" role="status">{message}</p>}
    <button className="rounded-lg bg-red-600 px-4 py-3 font-semibold text-white disabled:opacity-60" type="button" disabled={busy}
      onClick={() => void (sessionId && !transactionId ? confirm() : checkout())}>
      {busy ? 'Please wait…' : sessionId && !transactionId ? 'Check payment again' : 'Start a sandbox checkout'}
    </button>
  </main>;
}
