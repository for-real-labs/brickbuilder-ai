import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import PrivacyPolicyPage from "./pages/PrivacyPolicyPage";
import TermsOfServicePage from "./pages/TermsOfServicePage";

export const legalPages = [
  { path: "privacy", title: "Privacy Policy — BrickBuilder", Component: PrivacyPolicyPage },
  { path: "terms", title: "Terms of Service — BrickBuilder", Component: TermsOfServicePage },
] as const;

export function renderLegalDocument(shell: string, path: string) {
  const page = legalPages.find((item) => item.path === path);
  if (!page || !shell.includes('<div id="root"></div>')) {
    throw new Error("Unsupported legal page or missing application root");
  }
  const markup = renderToStaticMarkup(
    <HelmetProvider><MemoryRouter initialEntries={[`/${path}`]}><page.Component /></MemoryRouter></HelmetProvider>,
  );
  // Keep the normal app bundle so browser navigation, analytics and interactions
  // continue to use the same page. Crawlers receive its full policy text upfront.
  return shell.replace('<div id="root"></div>', `<div id="root">${markup}</div>`)
    .replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`)
    .replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/?\s*>/, `<link rel="canonical" href="https://brickbuilder.ai/${path}" />`);
}
