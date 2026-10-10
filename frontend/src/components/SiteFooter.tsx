import { isNativeMobileShell } from '../utils/mobileShellAnalytics';
import { openAiConsentSettings } from '../utils/aiConsent';
import React from "react";
import { Link } from "react-router-dom";
import { Github, Instagram, Youtube } from "lucide-react";
import posthog from "posthog-js";

// TikTok icon (not provided by lucide-react)
function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5.8 20.1a6.34 6.34 0 0 0 10.86-4.43V8.93a8.16 8.16 0 0 0 4.77 1.52V7a4.85 4.85 0 0 1-1.84-.31z" />
    </svg>
  );
}

export function SiteFooter() {
  return (
    <footer className="w-full py-6 text-center text-sm text-slate-500">
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-4">
          <a
            href="https://www.instagram.com/trybrickbuilder/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Instagram"
            className="text-slate-500 hover:text-[#f44336] transition-colors"
          >
            <Instagram className="h-5 w-5" />
          </a>
          <a
            href="https://www.youtube.com/@trybrickbuilder"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="YouTube"
            className="text-slate-500 hover:text-[#f44336] transition-colors"
          >
            <Youtube className="h-5 w-5" />
          </a>
          <a
            href="https://www.tiktok.com/@trybrickbuilder/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="TikTok"
            className="text-slate-500 hover:text-[#f44336] transition-colors"
          >
            <TikTokIcon className="h-5 w-5" />
          </a>
          <a
            href="https://github.com/jjohnson5253/brickbuilderai"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="GitHub"
            className="text-slate-500 hover:text-[#f44336] transition-colors"
          >
            <Github className="h-5 w-5" />
          </a>
        </div>
        <div>
          Need help?{" "}
          <a
            href="mailto:support@brickbuilder.ai"
            className="text-slate-600 hover:text-slate-900 underline"
          >
            support@brickbuilder.ai
          </a>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs">
          <Link to="/blog" className="hover:text-[#f44336] transition-colors">
            Blog
          </Link>
          <Link to="/use-ai-to-edit-ldraw" onClick={() => posthog.capture("footer_ldraw_editor_clicked")} className="hover:text-[#f44336] transition-colors">AI LDraw editor</Link>
          <Link to="/image-to-lego" onClick={() => posthog.capture('footer_image_to_lego_clicked')} className="hover:text-[#f44336] transition-colors">Image to LEGO</Link>
          <Link to="/photo-to-lego" onClick={() => posthog.capture('footer_photo_to_lego_clicked')} className="hover:text-[#f44336] transition-colors">Photo to LEGO</Link>
          <Link to="/glb-to-lego" className="hover:text-[#f44336] transition-colors">
            GLB to LEGO Converter
          </Link>
          <Link to="/community" className="hover:text-[#f44336] transition-colors">
            Community Models
          </Link>
          {isNativeMobileShell() && <button type="button" className="hover:text-[#f44336] transition-colors"
            onClick={() => {
              posthog.capture('footer_ai_privacy_clicked');
              void openAiConsentSettings().catch(() => undefined);
            }}>AI privacy</button>}
          <Link
            to="/privacy"
            onClick={() => posthog.capture("footer_privacy_policy_clicked")}
            className="hover:text-[#f44336] transition-colors"
          >
            Privacy Policy
          </Link>
          <Link to="/terms" onClick={() => posthog.capture("footer_terms_of_service_clicked")} className="hover:text-[#f44336] transition-colors">
            Terms of Service
          </Link>
        </div>
        <div className="text-xs text-slate-400">
          © 2026 BrickBuilder
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
