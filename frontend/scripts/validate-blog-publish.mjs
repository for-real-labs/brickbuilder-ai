import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export function assertBlogOnlyChanges(paths) {
  if (!paths.length) throw new Error('There are no blog changes to publish');
  const unexpected = paths.filter((path) => ![
    'frontend/src/data/substack-posts.json', 'frontend/public/substack-imports.json', 'frontend/public/sitemap.xml',
  ].includes(path));
  if (unexpected.length) throw new Error(`Refusing to publish non-blog files: ${unexpected.join(', ')}`);
}

if (basename(process.argv[1] || '') === 'validate-blog-publish.mjs') {
  const paths = execFileSync('git', ['diff', '--name-only', '-z', process.argv[2] || 'origin/main', 'HEAD'], { encoding: 'utf8' })
    .split('\0').filter(Boolean);
  assertBlogOnlyChanges(paths);
  console.log(`Validated ${paths.length} blog-only files.`);
}
