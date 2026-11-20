import { captureReferralLink } from './services/referrals';
import { preparePasswordRecoveryPage } from './services/passwordAuth';
import { captureSignVisit } from './utils/signAnalytics';
  import { createRoot } from "react-dom/client";
  import { PostHogProvider } from "posthog-js/react";
  import { HelmetProvider } from "react-helmet-async";
  import { AuthProvider } from "./contexts/AuthContext";
  import { registerMobileShellAnalytics } from "./utils/mobileShellAnalytics";
  import App from "./App.tsx";
  import StripeSandbox from './pages/StripeSandbox';
  import "./index.css";
  import { captureInstructionLink } from './utils/instructionLinks';

  const renderApp = () => createRoot(document.getElementById("root")!).render(
    <HelmetProvider>
      <PostHogProvider
        apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY}
        options={{
          api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
          ui_host: "https://us.posthog.com",
          defaults: "2025-05-24",
          capture_exceptions: true,
          debug: false,
          loaded: captureSignVisit,
        }}
      >
        <AuthProvider>
          <App />
        </AuthProvider>
      </PostHogProvider>
    </HelmetProvider>
  );

  if (window.location.pathname === '/stripe-sandbox' || window.location.pathname.startsWith('/stripe-sandbox/')) {
    createRoot(document.getElementById('root')!).render(<HelmetProvider><StripeSandbox /></HelmetProvider>);
  } else {
    captureInstructionLink();
    void captureReferralLink();
    registerMobileShellAnalytics();
    if (window.location.pathname === '/reset-password') {
      void preparePasswordRecoveryPage().then(renderApp);
    } else {
      renderApp();
    }
  }
