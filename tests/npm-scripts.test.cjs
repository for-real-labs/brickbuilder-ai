const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { scripts } = require('../package.json');

test('install prepares backend, frontend and the Nova forks', () => {
  assert.equal(scripts.postinstall, 'npm run install:backend && npm run install:frontend && npm run install:nova');
  assert.equal(scripts['install:backend'], 'node scripts/backend.cjs install');
  assert.equal(scripts['install:frontend'], 'npm --prefix frontend install');
  assert.equal(scripts['install:nova'], 'node scripts/nova.cjs install');
});

test('servers run in their project directories', () => {
  assert.equal(scripts['start:backend'], 'node scripts/backend.cjs start');
  assert.equal(scripts['start:frontend'], 'npm --prefix frontend run dev');
  assert.equal(scripts['start:nova'], 'node scripts/nova.cjs start');
});

for (const exitCode of [0, 1]) {
  test(`startup stops the other server when one exits with ${exitCode}`, { timeout: 15000 }, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'brickbuilder-start-'));
    const worker = path.join(directory, 'worker.cjs');
    writeFileSync(worker, `
      if (process.argv[2] === 'exit') {
        setTimeout(() => process.exit(${exitCode}), 800);
      } else {
        process.on('SIGTERM', () => { console.log('server-stopped'); process.exit(0); });
        setInterval(() => {}, 1000);
      }
    `);
    // Use the same supervisor options as npm start with tiny fixture servers.
    const command = scripts.start.replace('npm run start:backend', `node ${JSON.stringify(worker)} exit`)
      .replace('npm run start:frontend', `node ${JSON.stringify(worker)} wait`);
    const child = spawn(command, { shell: true, env: {
      ...process.env,
      PATH: `${path.resolve(__dirname, '../node_modules/.bin')}${path.delimiter}${process.env.PATH}`,
    } });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, exitCode, output);
      assert.match(output, /server-stopped/);
    } finally {
      child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}


test('Nova commands separate initial setup, latest update, and local status inspection', () => {
  assert.equal(scripts['setup:nova'], 'node scripts/nova.cjs setup');
  assert.equal(scripts['update:nova'], 'node scripts/nova.cjs update');
  assert.equal(scripts['nova:status'], 'node scripts/nova.cjs status');
});
