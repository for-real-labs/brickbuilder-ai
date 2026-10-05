import { describe, expect, it } from 'vitest';
import { assertBlogOnlyChanges } from '../scripts/validate-blog-publish.mjs';

describe('automatic Substack publication boundary', () => {
  it('allows only imported article data, manifest, and sitemap', () => {
    expect(() => assertBlogOnlyChanges(['frontend/src/data/substack-posts.json', 'frontend/public/substack-imports.json', 'frontend/public/sitemap.xml'])).not.toThrow();
  });
  it.each(['frontend/src/App.tsx', '.github/workflows/blog.yml', 'frontend/src/data/blog-posts.json', 'backend/src/app.py', 'frontend/public/../index.html'])('rejects %s', (path) => {
    expect(() => assertBlogOnlyChanges([path])).toThrow('Refusing to publish');
  });
  it('rejects empty changes', () => expect(() => assertBlogOnlyChanges([])).toThrow('no blog changes'));
});
