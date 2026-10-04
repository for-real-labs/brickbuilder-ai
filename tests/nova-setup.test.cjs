const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { SOURCES, ensureSource, findPython, setup } = require('../scripts/nova.cjs');

test('local and hosted installers share source pins and the backend runtime directory', () => {
  const hosted = require('../backend/setup_nova.cjs');
  assert.equal(setup, hosted.setup);
  assert.equal(SOURCES, hosted.SOURCES);
  const directories = [];
  ensureSource(SOURCES[0], (_command, _args, options) => {
    directories.push(options.cwd);
    return { status: 0 };
  }, () => false, () => {});
  assert.ok(directories.every(directory => directory === path.resolve(__dirname, '../backend/.nova/toolkit')));
});

test('Railway builds Nova after backend dependencies with the matching runtime paths', () => {
  const dockerfile = readFileSync(path.resolve(__dirname, '../backend/Dockerfile'), 'utf8');
  const install = dockerfile.indexOf('RUN node setup_nova.cjs');
  assert.ok(install > dockerfile.indexOf('COPY . .'));
  assert.ok(install > dockerfile.indexOf('RUN uv sync --frozen'));
  for (const setting of ['NOVA_TOOLKIT_ROOT=/app/.nova/toolkit', 'NOVA_PYTHON=/app/.nova/toolkit/.venv/bin/python', 'LDRAW_DIR=/root/ldraw']) {
    assert.ok(dockerfile.indexOf(`ENV ${setting}`) < install);
    assert.ok(dockerfile.includes(`ENV ${setting}`));
  }
  assert.match(dockerfile, /\s+git\s+\\/);
  assert.match(dockerfile, /\s+nodejs\s+\\/);
  const ignored = readFileSync(path.resolve(__dirname, '../backend/.dockerignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignored.includes('.nova'), 'local toolkit checkouts must not replace the pinned image runtime');
});

test('Nova sources use immutable commits and argument-based git calls', () => {
  const calls = [];
  ensureSource(SOURCES[0], (command, args, options) => {
    calls.push({ command, args });
    assert.equal(options.shell, undefined);
    return { status: 0 };
  }, () => false, () => {});
  assert.deepEqual(calls[2].args, ['fetch', '--depth', '1', 'origin', SOURCES[0].commit]);
  assert.match(SOURCES[0].commit, /^[a-f0-9]{40}$/);
  assert.match(SOURCES[1].commit, /^[a-f0-9]{40}$/);
});

test('setup refuses to overwrite unrelated or unpinned checkouts', () => {
  assert.throws(() => ensureSource(SOURCES[0], () => ({ status: 0, stdout: 'other-revision' }), () => true), /Unexpected toolkit revision/);
  assert.throws(() => ensureSource(SOURCES[0], () => assert.fail('must not run'), p => !p.endsWith('.git')), /exists without/);
});

test('explicit Nova Python is validated without shell interpolation', () => {
  assert.equal(findPython((command, args) => {
    assert.equal(command, '/Python with spaces/python');
    assert.match(args[1], /3, 12/);
    return { status: 0 };
  }, { NOVA_SETUP_PYTHON: '/Python with spaces/python' }), '/Python with spaces/python');
  assert.throws(() => findPython(() => ({ status: 1 }), {}), /Python 3.12\+/);
});

test('uv setup installs isolated pinned sources and indexes the actual parts library', () => {
  const calls = [];
  setup((command, args, options) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'rev-parse') {
      const source = options.cwd.endsWith('toolkit') ? SOURCES[0] : SOURCES[1];
      return { status: 0, stdout: source.commit };
    }
    return { status: 0, stdout: '/path with spaces/ldraw' };
  }, {}, 'linux', () => true, () => {});
  assert.ok(calls.some(call => call.command === 'uv' && call.args.includes('--frozen')));
  assert.ok(calls.some(call => call.args.at(-1) === 'index' && call.args.includes('/path with spaces/ldraw')));
  assert.ok(calls.some(call => call.args.slice(-2).join(' ') === 'discover index' && call.args.includes('/path with spaces/ldraw')));
  assert.ok(calls.every(call => !call.args.includes('leocad')));
});
