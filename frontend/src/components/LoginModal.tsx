import { getNativeMobileShellInfo } from '../utils/mobileShellAnalytics';
import { SignupCodeVerification } from './SignupCodeVerification';
import { PasswordRecovery } from './PasswordRecovery';
import React, { useEffect, useRef, useState, useId, FormEvent } from "react";
import posthog from "posthog-js";
import { useBilling } from "../contexts/BillingContext";
import { INITIAL_PLANS } from "../services/billingApi";
import { Mail, X } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import {
  AuthMethod,
  trackAuthMethodSelected,
  trackPasswordLoginSubmitted,
} from "../utils/authAnalytics";

interface LoginModalProps {
  open: boolean;
  intent?: "sign_in" | "claim_credits";
  onClose: () => void;
  onSuccess?: () => void;
  /**
   * Path Google OAuth should redirect back to after sign-in. Defaults to current page.
   */
  redirectTo?: string;
  /**
   * Hook invoked before Google or email-link sign-in so callers can persist transient state.
   */
  onBeforeOAuthRedirect?: () => Promise<void> | void;
}

export default function LoginModal({
  open,
  intent = "sign_in",
  onClose,
  onSuccess,
  redirectTo,
  onBeforeOAuthRedirect,
}: LoginModalProps) {
  const { plans } = useBilling();
  const freeCredits = (plans ?? INITIAL_PLANS).find(plan => plan.key === 'free')?.credits;
  const nativeIos = getNativeMobileShellInfo()?.platform === 'ios';
  const { signIn, signInWithGoogle, signInWithOtp, verifyOtp } = useAuth();
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>("magic_link");
  const id = useId();
  const claimingCredits = intent === "claim_credits";
  const track = (action: string) => posthog.capture("auth_modal_interaction", { surface: "login_modal", intent, action });
  const close = () => { track("dismiss"); onClose(); };
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    posthog.capture("auth_modal_opened", { surface: "login_modal", intent });
    const previousFocus = document.activeElement as HTMLElement | null;
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href]',
      ) ?? []).filter(element => element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    document.addEventListener("keydown", trapFocus);
    return () => { document.removeEventListener("keydown", trapFocus); previousFocus?.focus(); };
  }, [open, intent]);

  // Prefill remembered email when opening
  useEffect(() => {
    if (!open) return;
    const saved = localStorage.getItem("remember_email");
    if (saved) setEmail(saved);
  }, [open]);

  // Reset transient state whenever the modal closes
  useEffect(() => {
    if (open) return;
    setConfirmationRequired(false);
    setOtpCode("");
    setPassword("");
    setOtpSent(false);
    setAuthMethod("magic_link");
    setError(null);
    setLoading(false);
  }, [open]);

  // Lock background scroll while open; scroll to top on close (mobile keyboard
  // focus can push the page down while the modal is open).
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      window.scrollTo({ top: 0, behavior: "instant" });
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        posthog.capture("auth_modal_interaction", { surface: "login_modal", intent, action: "dismiss" });
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, intent]);

  if (!open) return null;

  const selectAuthMethod = (method: AuthMethod) => {
    setConfirmationRequired(false);
    setAuthMethod(method);
    setError(null);
    setOtpCode("");
    setOtpSent(false);
    setPassword("");
    trackAuthMethodSelected("login_modal", method);
  };

  const handleLoginSuccess = (closeWhenNoSuccess = false) => {
    if (remember) localStorage.setItem("remember_email", email);
    else localStorage.removeItem("remember_email");
    if (onSuccess) {
      onSuccess();
      return;
    }
    if (closeWhenNoSuccess) {
      onClose();
    }
  };

  const handleGetCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Please enter your email.");
      return;
    }
    try {
      setLoading(true);
      const target = redirectTo && redirectTo.startsWith("/")
        ? redirectTo
        : window.location.pathname + window.location.search;
      track("email_code_requested");
      await onBeforeOAuthRedirect?.();
      const { error: authError } = await signInWithOtp(email, target);
      if (authError) {
        setError(authError.message);
        return;
      }
      setOtpSent(true);
    } catch {
      setError("Could not send your code or save your draft. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setConfirmationRequired(false);
    setError(null);
    if (!email.trim()) {
      setError("Please enter your email.");
      return;
    }
    if (!password.trim()) {
      setError("Please enter your password.");
      return;
    }
    try {
      setLoading(true);
      trackPasswordLoginSubmitted("login_modal");
      await onBeforeOAuthRedirect?.();
      const { error: authError, confirmationRequired: needsConfirmation } = await signIn(email, password, redirectTo);
      if (authError) {
        setError(authError.message);
        return;
      }
      if (needsConfirmation) { setPassword(""); setConfirmationRequired(true); return; }
      handleLoginSuccess(true);
    } catch {
      setError("Password sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!otpCode.trim()) {
      setError("Please enter the code from your email.");
      return;
    }
    try {
      setLoading(true);
      track("email_code_verified");
      const { error: authError } = await verifyOtp(email, otpCode);
      if (authError) {
        setError(authError.message);
        return;
      }
      handleLoginSuccess(true);
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    track("google_selected");
    try {
      await onBeforeOAuthRedirect?.();
      const target = redirectTo && redirectTo.startsWith("/")
        ? redirectTo
        : window.location.pathname + window.location.search;
      const { error: authError } = await signInWithGoogle(target);
      if (authError) setError(authError.message);
    } catch {
      setError("Could not start Google sign-in or save your draft. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) close();
  };

  const googleOption = (
    <div data-native-mobile-hidden="true">
      {!claimingCredits && <div className="mt-5 flex items-center gap-3"><div className="h-px flex-1 bg-slate-200" /><span className="text-xs text-slate-400">or</span><div className="h-px flex-1 bg-slate-200" /></div>}
          <button
            type="button"
            className="h-11 w-full rounded-lg border border-slate-300 bg-white text-slate-800 transition-colors flex items-center justify-center gap-3 px-4 hover:bg-slate-50 hover:border-slate-400 mt-4 disabled:opacity-50"
            onClick={handleGoogleSignIn}
            disabled={loading}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 48 48"
              width="20"
              height="20"
              aria-hidden="true"
              focusable="false"
            >
              <path
                fill="#EA4335"
                d="M24 9.5c3.5 0 6.6 1.3 9.1 3.4l6.8-6.8C35.4 2.3 30 0 24 0 14.7 0 6.7 5.4 2.7 13.2l7.9 6.1C12.3 13.1 17.6 9.5 24 9.5z"
              />
              <path
                fill="#34A853"
                d="M46.1 24.5c0-1.7-.1-3.3-.4-4.9H24v9.3h12.6c-.6 3.1-2.5 5.7-5.2 7.4l8 6.2c4.6-4.3 6.7-10.6 6.7-18z"
              />
              <path
                fill="#4A90E2"
                d="M10.6 28.7c-1.1-3.1-1.1-6.5 0-9.6l-7.9-6.1C.9 17.7 0 20.8 0 24s.9 6.3 2.7 11.1l7.9-6.4z"
              />
              <path
                fill="#FBBC05"
                d="M24 48c6 0 11.4-2 15.1-5.4l-8-6.2c-2.2 1.4-5 2.2-7.1 2.2-6.4 0-11.8-3.6-13.4-8.6l-7.9 6.4C6.7 42.6 14.7 48 24 48z"
              />
            </svg>
            <span>Continue with Google</span>
          </button>
      {claimingCredits && <div className="mt-5 flex items-center gap-3"><div className="h-px flex-1 bg-slate-200" /><span className="text-xs text-slate-400">or continue with email</span><div className="h-px flex-1 bg-slate-200" /></div>}
    </div>
  );

  return (
    <div
      className="fixed inset-0 flex items-center justify-center overflow-y-auto bg-slate-950/60 backdrop-blur-md p-4"
      style={{ zIndex: 10000 }}
      onMouseDown={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
    >
      <div
        ref={dialogRef}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>

        {claimingCredits && <img src="/brickbuilder-logo.PNG" alt="BrickBuilder" className="mx-auto mb-5 mt-3 h-14 w-14 object-contain" />}
        <h2 id={`${id}-title`} className={claimingCredits ? "text-center text-2xl font-bold tracking-tight text-slate-900" : "text-md pr-8"}>
          {claimingCredits ? "One step from your brick model" : "Sign in to save builds and add to community!"}
        </h2>
        {claimingCredits && <p className="mt-2 text-center text-base text-slate-600">Sign up and claim {freeCredits ? `${freeCredits} free credits` : "your free credits"}.</p>}
        <p id={`${id}-description`} className={`mt-2 text-sm text-slate-500 ${claimingCredits ? "text-center" : ""}`}>
          {otpSent
            ? (nativeIos ? "Enter the code we sent to your email." : "Check your email for a magic link or enter the code we sent.")
            : authMethod === "password"
              ? "Sign in with your password, or create an account if you’re new."
              : claimingCredits ? "Already have an account? Sign in below." : "Enter email to login or sign-up."}
        </p>

        {claimingCredits && !confirmationRequired && !otpSent && googleOption}

        {!confirmationRequired && !otpSent && authMethod === "magic_link" && (
          <form onSubmit={handleGetCode} className="mt-5 space-y-4">
            <div>
              <label htmlFor={`${id}-email`} className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <div className="relative">
                <Mail
                  className="absolute h-4 w-4 text-slate-400"
                  style={{ left: 10, top: "50%", transform: "translateY(-50%)" }}
                />
                <input
                  id={`${id}-email`}
                  type="email"
                  autoFocus
                  autoComplete="email"
                  placeholder="yours@example.com"
                  className="input h-11 rounded-lg border-slate-300 w-full"
                  style={{ paddingLeft: 36 }}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember my email
            </label> */}

            <button
              type="submit"
              disabled={loading}
              className={`w-full h-11 rounded-xl text-white font-semibold transition-colors ${
                loading
                  ? "bg-red-300 cursor-not-allowed"
                  : "bg-[#f44336] hover:bg-[#ff6b6b] cursor-pointer"
              }`}
            >
{loading ? "Sending..." : claimingCredits ? "Get code" : nativeIos ? "Continue with email code" : "Continue with magic link"}
            </button>

            <button
              type="button"
              onClick={() => selectAuthMethod("password")}
              className="block w-full text-center text-sm text-slate-500 transition-colors hover:text-slate-700 hover:underline"
            >
              Use password
            </button>

            {error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </form>
        )}

        {!confirmationRequired && !otpSent && authMethod === "password" && (
          <form onSubmit={handlePasswordSignIn} className="mt-5 space-y-4">
            <div>
              <label htmlFor={`${id}-email`} className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <div className="relative">
                <Mail
                  className="absolute h-4 w-4 text-slate-400"
                  style={{ left: 10, top: "50%", transform: "translateY(-50%)" }}
                />
                <input
                  id={`${id}-email`}
                  type="email"
                  autoFocus
                  autoComplete="email"
                  placeholder="yours@example.com"
                  className="input h-11 rounded-lg border-slate-300 w-full"
                  style={{ paddingLeft: 36 }}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor={`${id}-password`} className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
                id={`${id}-password`}
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                className="input h-11 rounded-lg border-slate-300 w-full"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className={`w-full h-11 rounded-xl text-white font-semibold transition-colors ${
                loading
                  ? "bg-red-300 cursor-not-allowed"
                  : "bg-[#f44336] hover:bg-[#ff6b6b] cursor-pointer"
              }`}
            >
              {loading ? "Continuing..." : "Sign in or create account"}
            </button>

            <button
              type="button"
              onClick={() => selectAuthMethod("magic_link")}
              className="block w-full text-center text-sm text-slate-500 transition-colors hover:text-slate-700 hover:underline"
            >
              {nativeIos ? "Use email code instead" : "Use magic link instead"}
            </button>

            {error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </form>
        )}

        {otpSent && (
          <form onSubmit={handleVerifyCode} className="mt-5 space-y-4">
            <div>
              <label htmlFor={`${id}-code`} className="block text-sm font-medium text-slate-700 mb-1">
                Verification Code
              </label>
              <input
                id={`${id}-code`}
                type="text"
                inputMode="numeric"
                autoFocus
                autoComplete="one-time-code"
                placeholder="Enter 6-digit code"
                className="input h-11 rounded-lg border-slate-300 text-center text-lg tracking-widest w-full"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                required
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className={`w-full h-11 rounded-xl text-white font-semibold transition-colors ${
                loading
                  ? "bg-red-300 cursor-not-allowed"
                  : "bg-[#f44336] hover:bg-[#ff6b6b] cursor-pointer"
              }`}
            >
              {loading ? "Verifying..." : "Continue"}
            </button>

            <div className="flex justify-between text-sm">
              <button
                type="button"
                onClick={() => {
                  track("email_changed");
                  setOtpSent(false);
                  setOtpCode("");
                }}
                className="text-slate-600 hover:underline"
              >
                ← Change email
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={handleGetCode}
                className="text-[#f44336] hover:underline"
              >
                Resend code
              </button>
            </div>

            {error && (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </form>
        )}

          {confirmationRequired && <SignupCodeVerification email={email} redirectPath={redirectTo} surface="login_modal"
            onVerified={() => handleLoginSuccess(true)} onBack={() => setConfirmationRequired(false)} />}
          {(!claimingCredits || authMethod === "password") && <PasswordRecovery email={email} surface="login_modal" />}

        {!claimingCredits && googleOption}
        {claimingCredits && <p className="mt-6 text-center text-xs leading-5 text-slate-500">
          By continuing, you agree to our <a href="/terms" target="_blank" rel="noreferrer" onClick={() => track("terms_opened")} className="underline hover:text-slate-800">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noreferrer" onClick={() => track("privacy_opened")} className="underline hover:text-slate-800">Privacy Policy</a>.
        </p>}
      </div>
    </div>
  );
}
