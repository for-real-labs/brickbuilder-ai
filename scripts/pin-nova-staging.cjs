const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { SOURCES } = require('../backend/setup_nova.cjs');

function branchRevision(source, branch, run = spawnSync) {
  const ref = `refs/heads/${branch}`;
  const result = run('git', ['ls-remote', '--exit-code', source.url, ref], {
    encoding: 'utf8', stdio: 'pipe', timeout: 30000,
  });
  if (result.error || result.status !== 0) throw new Error(`Unable to read ${source.name}'s ${branch} branch.`);
  const rows = result.stdout.trim().split('\n');
  const [commit, returnedRef] = rows[0].split(/\s+/);
  if (rows.length !== 1 || returnedRef !== ref || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`Invalid ${branch} revision for ${source.name}.`);
  }
  return { ...source, commit };
}

function stagingRevision(source, run = spawnSync) {
  return branchRevision(source, 'staging', run);
}

function replacePins(content, previous, next) {
  return previous.reduce((updated, source, index) => {
    const oldPin = `url: '${source.url}', commit: '${source.commit}'`;
    if (updated.split(oldPin).length !== 2) throw new Error(`Review the ${source.name} pin format before updating.`);
    return updated.replace(oldPin, `url: '${source.url}', commit: '${next[index].commit}'`);
  }, content);
}

function pinNova({ branch = 'main-BrickBuilderAI', run = spawnSync, root = path.resolve(__dirname, '..') } = {}) {
  const setupPath = path.join(root, 'backend/setup_nova.cjs');
  const dockerfilePath = path.join(root, 'backend/nova-service/Dockerfile');
  const originalSetup = readFileSync(setupPath, 'utf8');
  const originalDockerfile = readFileSync(dockerfilePath, 'utf8');
  // Resolve both first: a missing branch must never leave a half-updated pair.
  const revisions = SOURCES.map(source => branchRevision(source, branch, run));
  const updatedSetup = replacePins(originalSetup, SOURCES, revisions);
  writeFileSync(setupPath, updatedSetup);
  try {
    // A fresh Node process reads the new pins rather than the cached module.
    const prepared = run(process.execPath, ['scripts/nova.cjs', '--prepare'], {
      cwd: root, stdio: 'inherit', timeout: 120000,
    });
    if (prepared.error || prepared.status !== 0) throw new Error('Unable to prepare the updated Nova revisions. Pins restored.');
  } catch (error) {
    writeFileSync(setupPath, originalSetup);
    writeFileSync(dockerfilePath, originalDockerfile);
    throw error;
  }
  return revisions;
}

function pinStaging(options = {}) {
  return pinNova({ ...options, branch: 'staging' });
}

if (require.main === module) {
  try {
    const revisions = pinStaging();
    for (const source of revisions) console.log(`${source.name}: ${source.commit}`);
    console.log('Review and commit backend/setup_nova.cjs and backend/nova-service/Dockerfile in your BrickBuilder staging PR.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { branchRevision, stagingRevision, replacePins, pinNova, pinStaging };
