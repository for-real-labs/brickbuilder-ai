import { PasswordRecovery } from '../components/PasswordRecovery';
import React, { useState, useEffect, FormEvent } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { SEO } from "../components/SEO";
import FallingBricks from "../components/FallingBricks";
import { Mail } from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { SiteFooter } from "../components/SiteFooter";
import { isOAuthLogin, loginRedirect } from "../utils/loginRedirect";
import {
  AuthMethod,
  trackAuthMethodSelected,
  trackPasswordLoginSubmitted,
} from "../utils/authAnalytics";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = (location.state as { from?: string } | null)?.from;
  const redirectTo = loginRedirect(location.search, fromState);
  const connectingApp = isOAuthLogin(redirectTo);
  const { signIn, signInWithGoogle, signInWithOtp, verifyOtp } = useAuth();
  const [email, setEmail] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(connectingApp || new URLSearchParams(location.search).get("method") === "password" ? "password" : "magic_link");

  useEffect(() => {
    const saved = localStorage.getItem("remember_email");
    if (saved) setEmail(saved);
  }, []);

  const selectAuthMethod = (method: AuthMethod) => {
    setConfirmationRequired(false);
    setAuthMethod(method);
    setError(null);
    setOtpCode("");
    setOtpSent(false);
    setPassword("");
    trackAuthMethodSelected("login_page", method);
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
      const { error: authError } = await signInWithOtp(email, redirectTo);
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
      if (remember) localStorage.setItem("remember_email", email);
      else localStorage.removeItem("remember_email");
      navigate(redirectTo);
    } catch {
      setError("Verification failed. Please try again.");
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
      trackPasswordLoginSubmitted("login_page");
      const { error: authError, confirmationRequired: needsConfirmation } = await signIn(email, password, redirectTo);
      if (authError) {
        setError(authError.message);
        return;
      }
      if (needsConfirmation) { setConfirmationRequired(true); return; }
      if (remember) localStorage.setItem("remember_email", email);
      else localStorage.removeItem("remember_email");
      navigate(redirectTo);
    } catch {
      setError("Password sign-in failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    const { error: authError } = await signInWithGoogle(redirectTo);
    if (authError) {
      setError(authError.message);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "#fff", position: "relative", overflow: "hidden" }}>
      <SEO title="Log in — BrickBuilder" description="Access your BrickBuilder account." url="https://brickbuilder.ai/login" />
      <FallingBricks density={22} opacity={0.25} zIndex={0} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 440, width: "100%", margin: "56px auto", padding: "0 16px" }}>
        {/* Header */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo.svg" alt="BrickBuilder" className="h-6 w-auto"
                 onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
            <span className="text-lg font-extrabold tracking-tight">
              <span className="text-[#ff4b4b]">BRICK</span><span className="text-slate-900">BUILDER</span>
            </span>
          </Link>
          <Link to="/signup" state={{ from: redirectTo }} className="text-sm text-slate-700 hover:text-black">Sign Up</Link>
        </header>

        {/* Card */}
        <main style={{ border: "1px solid #e5e7eb", borderRadius: 16, background: "#fff", padding: 24, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
          <h1 className="text-2xl font-extrabold">{connectingApp ? "Sign in to connect" : "Welcome!"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {otpSent
              ? "Check your email for a magic link or enter the code we sent."
              : authMethod === "password"
                ? "Sign in with your password, or create an account if you’re new."
                : "Enter email to login or sign-up."}
          </p>

          {/* Email Entry Form */}
          {!otpSent && authMethod === "magic_link" && (
            <form onSubmit={handleGetCode} className="mt-5 space-y-4">
              {/* Email */}
              <div>
                <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <div className="relative">
                  <Mail className="absolute h-4 w-4 text-slate-400" style={{ left: 10, top: "50%", transform: "translateY(-50%)" }} />
                  <input
                    id="login-email"
                    type="email"
                    autoFocus
                    autoComplete="email"
                    placeholder="yours@example.com"
                    className="input h-11 rounded-lg border-slate-300"
                    style={{ paddingLeft: 36 }}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Get Code Button */}
              <button
                type="submit"
                disabled={loading}
                className={`w-full h-11 rounded-xl text-white font-semibold transition-colors ${
                  loading 
                    ? 'bg-red-300 cursor-not-allowed' 
                    : 'bg-[#f44336] hover:bg-[#ff6b6b] cursor-pointer'
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
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
              )}
            </form>
          )}

          {!otpSent && authMethod === "password" && (
            <form onSubmit={handlePasswordSignIn} className="mt-5 space-y-4">
              <div>
                <label htmlFor="login-email" className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <div className="relative">
                  <Mail className="absolute h-4 w-4 text-slate-400" style={{ left: 10, top: "50%", transform: "translateY(-50%)" }} />
                  <input
                    id="login-email"
                    type="email"
                    autoFocus
                    autoComplete="email"
                    placeholder="yours@example.com"
                    className="input h-11 rounded-lg border-slate-300"
                    style={{ paddingLeft: 36 }}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-1">Password</label>
                <input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  className="input h-11 rounded-lg border-slate-300"
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
                    ? 'bg-red-300 cursor-not-allowed' 
                    : 'bg-[#f44336] hover:bg-[#ff6b6b] cursor-pointer'
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
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
              )}
            </form>
          )}

          {/* OTP Verification */}
          {otpSent && (
            <form onSubmit={handleVerifyCode} className="mt-5 space-y-4">
              {/* Code Input */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Verification Code</label>
                <input
                  type="text"
                  autoFocus
                  autoComplete="one-time-code"
                  placeholder="Enter 6-digit code"
                  className="input h-11 rounded-lg border-slate-300 text-center text-lg tracking-widest"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  required
                />
              </div>

              {/* Verify Button */}
              <button
                type="submit"
                disabled={loading}
                className={`w-full h-11 rounded-xl text-white font-semibold transition-colors ${
                  loading 
                    ? 'bg-red-300 cursor-not-allowed' 
                    : 'bg-[#f44336] hover:bg-[#ff6b6b] cursor-pointer'
                }`}
              >
                {loading ? "Verifying..." : "Continue"}
              </button>

              {/* Back / Resend */}
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  onClick={() => { setOtpSent(false); setOtpCode(""); }}
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
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
              )}
            </form>
          )}

          {confirmationRequired && <p role="status" className="mt-4 rounded-lg bg-blue-50 p-3 text-sm text-blue-900">If this is a new account, check your email to confirm it before signing in. Already registered? Your password may be incorrect; use the reset link below.</p>}
          <PasswordRecovery email={email} surface="login_page" />

          <div data-native-mobile-hidden="true">
            {/* Divider */}
            <div className="flex items-center gap-3 pt-4 mt-2">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs text-slate-500">or</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* Google OAuth */}
            <button
              type="button"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white text-slate-800 transition-colors flex items-center justify-center gap-3 px-4 hover:bg-slate-50 hover:border-slate-400 mt-4"
              onClick={handleGoogleSignIn}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="20" height="20" aria-hidden="true" focusable="false">
                <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.3 9.1 3.4l6.8-6.8C35.4 2.3 30 0 24 0 14.7 0 6.7 5.4 2.7 13.2l7.9 6.1C12.3 13.1 17.6 9.5 24 9.5z"/>
                <path fill="#34A853" d="M46.1 24.5c0-1.7-.1-3.3-.4-4.9H24v9.3h12.6c-.6 3.1-2.5 5.7-5.2 7.4l8 6.2c4.6-4.3 6.7-10.6 6.7-18z"/>
                <path fill="#4A90E2" d="M10.6 28.7c-1.1-3.1-1.1-6.5 0-9.6l-7.9-6.1C.9 17.7 0 20.8 0 24s.9 6.3 2.7 11.1l7.9-6.4z"/>
                <path fill="#FBBC05" d="M24 48c6 0 11.4-2 15.1-5.4l-8-6.2c-2.2 1.4-5 2.2-7.1 2.2-6.4 0-11.8-3.6-13.4-8.6l-7.9 6.4C6.7 42.6 14.7 48 24 48z"/>
              </svg>
              <span>Continue with Google</span>
            </button>
          </div>

          <p className="text-xs text-slate-500 text-center mt-2">
            Need an account? <Link to="/signup" state={{ from: redirectTo }} className="text-[#f44336] hover:underline">Sign up</Link>
          </p>
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
