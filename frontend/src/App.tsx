import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { GenerationNotificationsProvider } from "./contexts/GenerationNotificationsContext";

import LandingPage from "./pages/LandingPage";
import GeneratedModel from "./pages/GeneratedModel";
import OrderKit from "./pages/OrderKit";
import Success from "./pages/Success";
import { InstructionsPage } from "./pages/InstructionsPage";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import OAuthConsentPage from "./pages/OAuthConsentPage";
import UserDashboard from "./pages/UserDashboard"; // NEW
import CommunityPage from "./pages/CommunityPage";
import CompetitionsPage from "./pages/CompetitionsPage";
import GlbToLegoPage from "./pages/GlbToLegoPage";
import BlogIndexPage from "./pages/BlogIndexPage";
import UsingAiToDesignLego2026Page from "./pages/UsingAiToDesignLego2026Page";
import BestAiLegoDesignTools2026Page from "./pages/BestAiLegoDesignTools2026Page";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import { ChangeRequestProvider } from "./components/ChangeRequestLauncher";
import { FeedbackWidget } from "./components/FeedbackWidget";
// import { ProtectedRoute } from "./components/ProtectedRoute";

function ExternalRedirect({ to }: { to: string }) {
  if (typeof window !== "undefined") {
    window.location.replace(to);
  }
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <GenerationNotificationsProvider>
      <ChangeRequestProvider>
        {/* <ProtectedRoute> */}
        {/* <AnnouncementBanner /> */}
        <Routes>
          {/* Public */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/landing" element={<Navigate to="/" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/oauth/consent" element={<OAuthConsentPage />} />

          {/* App pages */}
          <Route path="/dashboard" element={<UserDashboard />} /> {/* NEW */}
          <Route path="/generated-model" element={<GeneratedModel />} />
          <Route path="/glb-to-lego" element={<GlbToLegoPage />} />
          <Route path="/instructions" element={<InstructionsPage />} />
          <Route path="/order" element={<OrderKit />} />
          <Route path="/success" element={<Success />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/competitions" element={<CompetitionsPage />} />
          <Route path="/blog" element={<BlogIndexPage />} />
          <Route path="/blog/using-ai-to-design-lego-in-2026" element={<UsingAiToDesignLego2026Page />} />
          <Route path="/blog/best-ai-lego-design-tools-2026" element={<BestAiLegoDesignTools2026Page />} />
          <Route path="/privacy" element={<PrivacyPolicyPage />} />

          {/* External redirects */}
          <Route
            path="/brickworld26"
            element={
              <ExternalRedirect to="https://docs.google.com/presentation/d/1oI4e2VkhY3XyYzyPsceF538b2fIle7ZknC3XZzzUl-Y/edit?usp=sharing" />
            }
          />

          {/* Fallback */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        {/* </ProtectedRoute> */}
      </ChangeRequestProvider>
      <FeedbackWidget />
      </GenerationNotificationsProvider>
    </BrowserRouter>
  );
}
