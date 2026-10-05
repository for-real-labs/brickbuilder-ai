import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export function isImportManifestDeployed(expected, actual) {
  if (expected?.version !== 1 || actual?.version !== 1 || !Array.isArray(expected.items) || !Array.isArray(actual.items)) return false;
  return expected.items.every((item) => actual.items.some((deployed) => (
    item && deployed && typeof item.guid === 'string' && deployed.guid === item.guid && deployed.slug === item.slug && deployed.sourceUrl === item.sourceUrl
  )));
}

if (basename(process.argv[1] || '') === 'verify-substack-deployment.mjs') {
  const expected = JSON.parse(await readFile(process.argv[2], 'utf8'));
  let deployed = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(process.argv[3], { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (response.ok && isImportManifestDeployed(expected, await response.json())) {
        deployed = true;
        break;
      }
    } catch { /* Deployments can briefly return old content or be unavailable. */ }
    await setTimeout(5000);
  }
  if (!deployed) throw new Error('Substack posts merged, but the live import manifest did not update within five minutes');
  console.log('All imported Substack posts are present in the live deployment.');
}
