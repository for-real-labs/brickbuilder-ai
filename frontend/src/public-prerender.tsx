import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider, type HelmetServerState } from 'react-helmet-async';
import { AuthProvider } from './contexts/AuthContext';
import { IMAGE_LANDING_PAGES } from './imageLandingPages';
import importedPosts from './data/substack-posts.json';
import LandingPage from './pages/LandingPage';
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import GlbToLegoPage from './pages/GlbToLegoPage';
import ObjToLegoPage from './pages/ObjToLegoPage';
import BlogIndexPage from './pages/BlogIndexPage';
import UsingAiToDesignLego2026Page from './pages/UsingAiToDesignLego2026Page';
import BestAiLegoDesignTools2026Page from './pages/BestAiLegoDesignTools2026Page';
import SubstackPostPage from './pages/SubstackPostPage';
import PrivacyPolicyPage from './pages/PrivacyPolicyPage';
import TermsOfServicePage from './pages/TermsOfServicePage';

const publicPages = [
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/signup', element: <SignupPage /> },
  { path: '/glb-to-lego', element: <GlbToLegoPage /> },
  { path: '/obj-to-lego', element: <ObjToLegoPage /> },
  { path: '/blog', element: <BlogIndexPage /> },
  { path: '/blog/using-ai-to-design-lego-in-2026', element: <UsingAiToDesignLego2026Page /> },
  { path: '/blog/best-ai-lego-design-tools-2026', element: <BestAiLegoDesignTools2026Page /> },
  { path: '/privacy', element: <PrivacyPolicyPage /> },
  { path: '/terms', element: <TermsOfServicePage /> },
  ...Object.keys(IMAGE_LANDING_PAGES).map((path) => ({
    path: `/${path}`,
    element: <LandingPage imageLandingPath={path as keyof typeof IMAGE_LANDING_PAGES} />,
  })),
  ...importedPosts.map(({ slug }) => {
    // Imported content is checked in, but its slug also becomes a build file path.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error('Invalid public article slug');
    }
    return { path: `/blog/${slug}`, element: <SubstackPostPage /> };
  }),
];

export const publicPagePaths = publicPages.map(({ path }) => path);

export function renderPublicDocument(shell: string, path: string): string {
  const page = publicPages.find((item) => item.path === path);
  if (!page || !shell.includes('<div id="root"></div>') || !shell.includes('</head>')) {
    throw new Error('Unsupported public page or missing application shell');
  }

  const context: { helmet?: HelmetServerState } = {};
  const canUseDOM = HelmetProvider.canUseDOM;
  // Use Helmet's server collector even in DOM-enabled test environments.
  HelmetProvider.canUseDOM = false;
  let markup: string;
  try {
    markup = renderToStaticMarkup(
      <HelmetProvider context={context}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider>
            <Routes><Route path={path.startsWith('/blog/') ? '/blog/:slug' : path} element={page.element} /></Routes>
          </AuthProvider>
        </MemoryRouter>
      </HelmetProvider>,
    );
  } finally {
    HelmetProvider.canUseDOM = canUseDOM;
  }

  const helmet = context.helmet;
  if (!helmet || !helmet.link.toString().includes('rel="canonical"')) {
    throw new Error(`Public page is missing SEO metadata: ${path}`);
  }

  // Replace homepage defaults with the same metadata used in the app.
  // Keep assets, viewport, favicons, and the browser bundle intact.
  const document = shell
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/g, '')
    .replace(/<meta\b[^>]*(?:name="(?:title|description|keywords|robots|twitter:[^"]+)"|property="og:[^"]+")[^>]*>/g, '')
    .replace(/<link\b[^>]*rel="canonical"[^>]*>/g, '')
    .replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/g, '');
  const head = helmet.title.toString() + helmet.meta.toString() + helmet.link.toString() + helmet.script.toString();
  return document
    .replace('</head>', () => `${head}</head>`)
    .replace('<div id="root"></div>', () => `<div id="root">${markup}</div>`);
}
