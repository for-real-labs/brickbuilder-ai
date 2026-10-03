const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

test('backend-only deployments and local launcher share the same updater', () => {
  const shared = require('../backend/scripts/nova-runtime.cjs');
  assert.equal(require('../scripts/nova.cjs'), shared);
  const dockerfile = readFileSync(path.join(__dirname, '../backend/Dockerfile'), 'utf8');
  assert.match(dockerfile, /\bgit\s*\\/);
  assert.match(dockerfile, /\bnodejs\s*\\/);
  assert.ok(dockerfile.indexOf('uv sync --frozen') < dockerfile.indexOf('node scripts/nova-runtime.cjs setup'));
  const ignore = readFileSync(path.join(__dirname, '../backend/.dockerignore'), 'utf8').split(/\r?\n/);
  for (const name of ['.env', '.nova', '.local_storage', '.local_postgres']) assert.ok(ignore.includes(name));
});

test('deployment refresh uses the resilient automatic mode before API launch', () => {
  const file = path.join(__dirname, '../backend/start.sh');
  const source = readFileSync(file, 'utf8');
  assert.match(source, /scripts\/nova-runtime\.cjs" auto\s*&\s*\n/);
  assert.ok(source.indexOf('nova-runtime.cjs') < source.indexOf('exec uv run uvicorn'));
  assert.ok(!source.includes('BRICKBUILDER_LOCAL_PROVIDERS=true'));
  if (process.platform !== 'win32') assert.equal(spawnSync('bash', ['-n', file]).status, 0);
});

test('backend-only updater automatic entrypoint starts normally without an installed runtime', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nova-deploy-test-'));
  try {
    const script = path.join(__dirname, '../backend/scripts/nova-runtime.cjs');
    const result = spawnSync(process.execPath, ['-e',
      'const updater=require(process.argv[1]);console.log(JSON.stringify(updater.autoUpdate({backendRoot:process.argv[2],env:{},log:()=>{}})))', script, directory],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).status, 'not_installed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
