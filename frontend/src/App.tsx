import { StudioTransferGate } from "./components/StudioTransferGate";
import { AiBillingPrompt } from './components/AiBillingPrompt';
import ImageToModelPage from './pages/ImageToModelPage';
import { IMAGE_MODEL_PAGES } from './imageModelPages';
import ModelToVoxelPage from './pages/ModelToVoxelPage';
import { VOXEL_CONVERTERS } from './voxelConverters';
import { AiConsentDialog } from "./components/AiConsentDialog";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { GenerationNotificationsProvider } from "./contexts/GenerationNotificationsContext";

import LandingPage from "./pages/LandingPage";
import { GeneratedModelRedirect } from "./components/GeneratedModelRedirect";
import OrderKit from "./pages/OrderKit";
import Success from "./pages/Success";
import LoginPage from "./pages/LoginPage";
import SignupPage from "./pages/SignupPage";
import OAuthConsentPage from "./pages/OAuthConsentPage";
import UserDashboard from "./pages/UserDashboard"; // NEW
import CommunityPage from "./pages/CommunityPage";
import CompetitionsPage from "./pages/CompetitionsPage";
import GlbToLegoPage from "./pages/GlbToLegoPage";
import ObjToLegoPage from "./pages/ObjToLegoPage";
import ModelFormatConverterPage from "./pages/ModelFormatConverterPage";
import BlogIndexPage from "./pages/BlogIndexPage";
import UsingAiToDesignLego2026Page from "./pages/UsingAiToDesignLego2026Page";
import BestAiLegoDesignTools2026Page from "./pages/BestAiLegoDesignTools2026Page";
import SubstackPostPage from "./pages/SubstackPostPage";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import TermsOfServicePage from "./pages/TermsOfServicePage";
import PetPreviewPage from './pages/PetPreviewPage';
import { AnnouncementBanner } from "./components/AnnouncementBanner";
import { ChangeRequestProvider } from "./components/ChangeRequestLauncher";
import { BillingProvider } from './contexts/BillingContext';
import { BillingOverlays } from './components/BillingComponents';
import PricingPage from './pages/PricingPage';
import BillingPage from './pages/BillingPage';
import { PetProvider } from "./contexts/PetContext";
import { PetCompanion } from "./components/PetCompanion";
import { MobileAppBanner } from "./components/MobileAppBanner";
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
      <MobileAppBanner />
      <PetProvider>
      <BillingProvider>
      <AiConsentDialog />
      <AiBillingPrompt />
      <GenerationNotificationsProvider>
      <ChangeRequestProvider>
        {/* <ProtectedRoute> */}
        {/* <AnnouncementBanner /> */}
        <StudioTransferGate>
        <Routes>
          {/* Public */}
          {IMAGE_MODEL_PAGES.map(({ path, output }) => <Route key={path} path={path} element={<ImageToModelPage key={path} output={output} />} />)}
          <Route path="/" element={<LandingPage />} />
          <Route path="/use-ai-to-edit-ldraw" element={<LandingPage imageLandingPath="use-ai-to-edit-ldraw" />} />
          <Route path="/image-to-lego" element={<LandingPage imageLandingPath="image-to-lego" />} />
          <Route path="/photo-to-lego" element={<LandingPage imageLandingPath="photo-to-lego" />} />
          <Route path="/landing" element={<Navigate to="/" replace />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/oauth/consent" element={<OAuthConsentPage />} />

          {/* App pages */}
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/dashboard" element={<UserDashboard />} /> {/* NEW */}
          <Route path="/generated-model" element={<GeneratedModelRedirect />} />
          <Route path="/glb-to-lego" element={<GlbToLegoPage />} />
          <Route path="/obj-to-lego" element={<ObjToLegoPage />} />
          {VOXEL_CONVERTERS.map(({ path, input, output }) => <Route key={path} path={path} element={<ModelToVoxelPage key={path} input={input} output={output} />} />)}
          <Route path="/obj-to-glb" element={<ModelFormatConverterPage inputFormat="obj" />} />
          <Route path="/glb-to-obj" element={<ModelFormatConverterPage inputFormat="glb" />} />
          <Route path="/instructions" element={<GeneratedModelRedirect instructions />} />
          <Route path="/order" element={<OrderKit />} />
          <Route path="/success" element={<Success />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="/competitions" element={<CompetitionsPage />} />
          <Route path="/blog" element={<BlogIndexPage />} />
          <Route path="/blog/using-ai-to-design-lego-in-2026" element={<UsingAiToDesignLego2026Page />} />
          <Route path="/blog/best-ai-lego-design-tools-2026" element={<BestAiLegoDesignTools2026Page />} />
          <Route path="/blog/:slug" element={<SubstackPostPage />} />
          <Route path="/privacy" element={<PrivacyPolicyPage />} />
          <Route path="/terms" element={<TermsOfServicePage />} />
          <Route path="/pet-preview" element={<PetPreviewPage />} />

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
        </StudioTransferGate>
        {/* </ProtectedRoute> */}
      </ChangeRequestProvider>
      </GenerationNotificationsProvider>
      <PetCompanion />
      <BillingOverlays />
      </BillingProvider>
      </PetProvider>
    </BrowserRouter>
  );
}
