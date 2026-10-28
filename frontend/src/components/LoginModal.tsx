import { PasswordRecovery } from './PasswordRecovery';
import React, { useEffect, useRef, useState, FormEvent } from "react";
import { Mail, X } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import {
  AuthMethod,
  trackAuthMethodSelected,
  trackPasswordLoginSubmitted,
} from "../utils/authAnalytics";

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  /**
   * Path Google OAuth should redirect back to after sign-in. Defaults to current page.
   */
  redirectTo?: string;
  /**
   * Hook invoked just before redirecting to Google so callers can persist transient state.
   */
  onBeforeOAuthRedirect?: () => Promise<void> | void;
}

export default function LoginModal({
  open,
  onClose,
  onSuccess,
  redirectTo,
  onBeforeOAuthRedirect,
}: LoginModalProps) {
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
  const dialogRef = useRef<HTMLDivElement | null>(null);

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
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      const { error: authError } = await signInWithOtp(email, target);
      if (authError) {
        setError(authError.message);
        return;
      }
      setOtpSent(true);
    } catch {
      setError("Failed to send code. Please try again.");
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
      const { error: authError, confirmationRequired: needsConfirmation } = await signIn(email, password, redirectTo);
      if (authError) {
        setError(authError.message);
        return;
      }
      if (needsConfirmation) { setConfirmationRequired(true); return; }
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
      const { error: authError } = await verifyOtp(email, otpCode);
      if (authError) {
        setError(authError.message);
        return;
      }
      handleLoginSuccess();
    } catch {
      setError("Verification failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    try {
      await onBeforeOAuthRedirect?.();
    } catch (err) {
      console.warn("onBeforeOAuthRedirect failed:", err);
    }
    const target = redirectTo && redirectTo.startsWith("/")
      ? redirectTo
      : window.location.pathname + window.location.search;
    const { error: authError } = await signInWithGoogle(target);
    if (authError) {
      setError(authError.message);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm px-4"
      style={{ zIndex: 10000 }}
      onMouseDown={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
    >
      <div
        ref={dialogRef}
        className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-md pr-8">Sign in to save builds and add to community!</h2>
        <p className="mt-1 text-sm text-slate-600">
          {otpSent
            ? "Check your email for a magic link or enter the code we sent."
            : authMethod === "password"
              ? "Sign in with your password, or create an account if you’re new."
              : "Enter email to login or sign-up."}
        </p>

        {!otpSent && authMethod === "magic_link" && (
          <form onSubmit={handleGetCode} className="mt-5 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <div className="relative">
                <Mail
                  className="absolute h-4 w-4 text-slate-400"
                  style={{ left: 10, top: "50%", transform: "translateY(-50%)" }}
                />
                <input
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
              {loading ? "Sending..." : "Continue with magic link"}
            </button>

            <button
              type="button"
              onClick={() => selectAuthMethod("password")}
              className="block w-full text-center text-sm text-slate-500 transition-colors hover:text-slate-700 hover:underline"
            >
              Use password
            </button>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </form>
        )}

        {!otpSent && authMethod === "password" && (
          <form onSubmit={handlePasswordSignIn} className="mt-5 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <div className="relative">
                <Mail
                  className="absolute h-4 w-4 text-slate-400"
                  style={{ left: 10, top: "50%", transform: "translateY(-50%)" }}
                />
                <input
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
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input
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
              Use magic link instead
            </button>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </form>
        )}

        {otpSent && (
          <form onSubmit={handleVerifyCode} className="mt-5 space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Verification Code
              </label>
              <input
                type="text"
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
                  setOtpSent(false);
                  setOtpCode("");
                }}
                className="text-slate-600 hover:underline"
              >
                ← Change email
              </button>
              <button
                type="button"
                onClick={handleGetCode}
                className="text-[#f44336] hover:underline"
              >
                Resend code
              </button>
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
          </form>
        )}

          {confirmationRequired && <p role="status" className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">If this is a new account, check your email to confirm it before signing in. Already registered? Your password may be incorrect; use the reset link below.</p>}
          <PasswordRecovery email={email} surface="login_modal" />

        <div data-native-mobile-hidden="true">
          <div className="flex items-center gap-3 pt-4 mt-2">
            <div className="h-px flex-1 bg-slate-200" />
            <span className="text-xs text-slate-500">or</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <button
            type="button"
            className="h-11 w-full rounded-lg border border-slate-300 bg-white text-slate-800 transition-colors flex items-center justify-center gap-3 px-4 hover:bg-slate-50 hover:border-slate-400 mt-4"
            onClick={handleGoogleSignIn}
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
        </div>
      </div>
    </div>
  );
}
