import { describe, expect, it } from 'vitest';
import { isImportManifestDeployed } from '../scripts/verify-substack-deployment.mjs';

const post = { guid: 'post-1', slug: 'a-post', sourceUrl: 'https://writer.substack.com/p/a-post' };
const manifest = { version: 1, items: [post] };

describe('live Substack deployment verification', () => {
  it('accepts the expected posts and additional newer posts', () => {
    expect(isImportManifestDeployed(manifest, { version: 1, items: [post, { guid: 'new' }] })).toBe(true);
  });
  it('rejects missing or mismatched posts', () => {
    expect(isImportManifestDeployed(manifest, { version: 1, items: [] })).toBe(false);
    expect(isImportManifestDeployed(manifest, { version: 1, items: [{ ...post, slug: 'wrong' }] })).toBe(false);
    expect(isImportManifestDeployed(manifest, { version: 1, items: [{ ...post, sourceUrl: 'wrong' }] })).toBe(false);
  });
  it.each([null, {}, { version: 1, items: [null] }, { version: 2, items: [post] }, { version: 1, items: {} }])('rejects invalid manifests', (actual) => {
    expect(isImportManifestDeployed(manifest, actual)).toBe(false);
    expect(isImportManifestDeployed(actual, manifest)).toBe(false);
  });
});
