import { IMAGE_LANDING_PAGES, type ImageLandingPath } from './imageLandingPages';
import { renderPublicDocument } from './public-prerender';

export const imageLandingPaths = Object.keys(IMAGE_LANDING_PAGES) as ImageLandingPath[];

export function renderLegalDocument(shell: string, path: string) {
  if (path !== 'privacy' && path !== 'terms') throw new Error('Unsupported legal page');
  return renderPublicDocument(shell, `/${path}`);
}

export function renderImageLandingDocument(shell: string, path: ImageLandingPath) {
  return renderPublicDocument(shell, `/${path}`);
}
