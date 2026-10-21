import { IMAGE_MODEL_PAGES } from '../imageModelPages';
import { LegoDesignCallout } from './LegoDesignCallout';
import { VOXEL_CONVERTERS, VOXEL_FORMATS } from '../voxelConverters';
import { isNativeMobileShell } from '../utils/mobileShellAnalytics';
import { openAiConsentSettings } from '../utils/aiConsent';
import React from "react";
import { Link, useLocation } from "react-router-dom";
import { Github, Instagram, Youtube } from "lucide-react";
import posthog from "posthog-js";
import { AppStoreLink } from './AppStoreLink';

import { TikTokIcon } from "./TikTokIcon";

export function SiteFooter() {
  const { pathname } = useLocation();
  const showDesignCallout = pathname.includes('-to-') && !VOXEL_CONVERTERS.some(({ path }) => path === pathname);
  return (
    <footer className="w-full px-4 py-6 text-center text-sm text-slate-500">
      <div className="flex flex-col items-center gap-3">
        {showDesignCallout && <div className="mb-6 w-full max-w-3xl"><LegoDesignCallout page={pathname} /></div>}
        <AppStoreLink placement="footer" page={pathname} />
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
            href="https://github.com/for-real-labs/brickbuilder-ai"
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
        <details className="w-full max-w-3xl" onToggle={event => {
          posthog.capture('footer_tools_toggled', { expanded: event.currentTarget.open, page: pathname });
        }}>
          <summary className="mx-auto w-fit cursor-pointer rounded-full px-3 py-2 text-xs font-medium transition-colors hover:text-[#f44336] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f44336]">
            Tools &amp; converters
          </summary>
          <div className="mt-3 space-y-4 rounded-2xl border border-slate-200 bg-white/70 p-4">
            <nav aria-label="LEGO and model tools" className="flex flex-wrap justify-center gap-x-4 gap-y-3 text-xs">
                <Link to="/use-ai-to-edit-ldraw" onClick={() => posthog.capture("footer_ldraw_editor_clicked")} className="hover:text-[#f44336] transition-colors">AI LDraw editor</Link>
                <Link to="/image-to-lego" onClick={() => posthog.capture('footer_image_to_lego_clicked')} className="hover:text-[#f44336] transition-colors">Image to LEGO</Link>
                <Link to="/photo-to-lego" onClick={() => posthog.capture('footer_photo_to_lego_clicked')} className="hover:text-[#f44336] transition-colors">Photo to LEGO</Link>
                <Link to="/glb-to-lego" className="hover:text-[#f44336] transition-colors">
                  GLB to LEGO Converter
                </Link>
                <Link to="/obj-to-lego" onClick={() => posthog.capture('footer_obj_to_lego_clicked')} className="hover:text-[#f44336] transition-colors">OBJ to LEGO Converter</Link>
                <Link to="/obj-to-glb" onClick={() => posthog.capture('footer_obj_to_glb_clicked')} className="hover:text-[#f44336] transition-colors">OBJ to GLB Converter</Link>
                <Link to="/glb-to-obj" onClick={() => posthog.capture('footer_glb_to_obj_clicked')} className="hover:text-[#f44336] transition-colors">GLB to OBJ Converter</Link>
            </nav>
            <nav aria-label="Image to 3D converters" className="flex max-w-3xl flex-wrap justify-center gap-x-4 gap-y-2 text-xs">
              {IMAGE_MODEL_PAGES.map(({ path, name }) => <Link key={path} to={path}
                onClick={() => posthog.capture('footer_image_model_converter_clicked', { destination: path })}
                className="hover:text-[#f44336] transition-colors">{name}</Link>)}
            </nav>
            <nav aria-label="Voxel converters" className="flex max-w-3xl flex-wrap justify-center gap-x-4 gap-y-2 text-xs">
              {VOXEL_CONVERTERS.map(({ path, input, output }) => <Link key={path} to={path}
                onClick={() => posthog.capture('footer_voxel_converter_clicked', { destination: path })}
                className="hover:text-[#f44336] transition-colors">{input.toUpperCase()} to {VOXEL_FORMATS[output].name}</Link>)}
            </nav>
          </div>
        </details>
        <div className="text-xs text-slate-400">
          © 2026 BrickBuilder
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
