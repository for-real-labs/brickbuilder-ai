  import { createRoot } from "react-dom/client";
  import { PostHogProvider } from "posthog-js/react";
  import { HelmetProvider } from "react-helmet-async";
  import { AuthProvider } from "./contexts/AuthContext";
  import { registerMobileShellAnalytics } from "./utils/mobileShellAnalytics";
  import App from "./App.tsx";
  import "./index.css";
  import { captureInstructionLink } from './utils/instructionLinks';

  captureInstructionLink();
  registerMobileShellAnalytics();

  createRoot(document.getElementById("root")!).render(
    <HelmetProvider>
      <PostHogProvider
        apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY}
        options={{
          api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST,
          ui_host: "https://us.posthog.com",
          defaults: "2025-05-24",
          capture_exceptions: true,
          debug: false,
        }}
      >
        <AuthProvider>
          <App />
        </AuthProvider>
      </PostHogProvider>
    </HelmetProvider>
  );
