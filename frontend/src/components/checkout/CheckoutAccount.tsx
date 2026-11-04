import React, { useState } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '../../contexts/AuthContext';
import { SignupCodeVerification } from '../SignupCodeVerification';
import { PasswordRecovery } from '../PasswordRecovery';

export function CheckoutAccount({ redirectPath }: { redirectPath: string }) {
  const { signIn, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verification, setVerification] = useState(false);
  const authenticate = async (google = false) => {
    if (busy) return;
    setBusy(true); setError('');
    posthog.capture('plan_checkout_auth_submitted', { method: google ? 'google' : 'password' });
    try {
      if (google) {
        const result = await signInWithGoogle(redirectPath);
        if (result.error) throw result.error;
      } else {
        const result = await signIn(email.trim(), password, redirectPath);
        if (result.error) throw result.error;
        setVerification(Boolean(result.confirmationRequired));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in. Please try again.'); }
    finally { setBusy(false); }
  };
  return <div className="plan-checkout-account">
    {verification ? <SignupCodeVerification email={email} redirectPath={redirectPath} surface="plan_checkout"
      onVerified={() => setVerification(false)} onBack={() => setVerification(false)} /> : <>
      <form onSubmit={event => { event.preventDefault(); void authenticate(); }}>
        <label className="checkout-field"><span>Email address</span><input type="email" autoComplete="email" required value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
        <label className="checkout-field"><span>Password</span><input type="password" autoComplete="current-password" required minLength={6} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
        {error && <p className="checkout-error" role="alert">{error}</p>}
        <button type="submit" className="checkout-primary" disabled={busy}>{busy ? 'Please wait…' : 'Continue to payment'}</button>
      </form>
      <PasswordRecovery email={email} surface="plan_checkout" />
      <div className="plan-checkout-divider">or</div>
      <button type="button" className="plan-checkout-google" disabled={busy} onClick={() => void authenticate(true)}>Continue with Google</button>
    </>}
    {verification && <PasswordRecovery email={email} surface="plan_checkout" />}
  </div>;
}
