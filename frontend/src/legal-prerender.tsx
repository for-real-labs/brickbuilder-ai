import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
import LandingPage from "./pages/LandingPage";
import { AuthProvider } from "./contexts/AuthContext";
import { IMAGE_LANDING_PAGES, type ImageLandingPath } from "./imageLandingPages";
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

export const imageLandingPaths = Object.keys(IMAGE_LANDING_PAGES) as ImageLandingPath[];
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function renderImageLandingDocument(shell: string, path: ImageLandingPath) {
  const page = IMAGE_LANDING_PAGES[path];
  const url = `https://brickbuilder.ai/${path}`;
  const markup = renderToStaticMarkup(<HelmetProvider><MemoryRouter initialEntries={[`/${path}`]}>
    <AuthProvider><LandingPage imageLandingPath={path} /></AuthProvider>
  </MemoryRouter></HelmetProvider>);
  let document = shell.replace('<div id="root"></div>', `<div id="root">${markup}</div>`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeAttribute(page.title)}</title>`)
    .replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/?\s*>/, `<link rel="canonical" href="${url}" />`);
  for (const [key, value] of Object.entries({ title: page.title, description: page.description, keywords: page.keywords,
    'og:title': page.title, 'og:description': page.description, 'og:url': url,
    'twitter:title': page.title, 'twitter:description': page.description, 'twitter:url': url })) {
    document = document.replace(new RegExp(`<meta (?:name|property)="${key}" content="[^"]*"\\s*\\/?\\s*>`),
      `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${escapeAttribute(value)}" />`);
  }
  const schema = { '@context': 'https://schema.org', '@type': 'WebApplication', name: page.title,
    description: page.description, url, applicationCategory: 'DesignApplication', operatingSystem: 'Web Browser' };
  document = document.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '')
    .replace('</head>', `<script type="application/ld+json">${JSON.stringify(schema)}</script></head>`);
  return document;
}
