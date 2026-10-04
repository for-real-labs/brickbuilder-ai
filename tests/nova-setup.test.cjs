const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SOURCES, ensureSource, setup } = require('../scripts/nova.cjs');

test('local setup delegates to the same two-repository runtime installer', () => {
  assert.equal(setup, require('../backend/setup_nova.cjs').setup);
  assert.equal(SOURCES.length, 2);
  assert.match(SOURCES[0].url, /ldraw-nova\.git$/);
  assert.match(SOURCES[1].url, /ldraw-nova-docker\.git$/);
  SOURCES.forEach(source => assert.match(source.commit, /^[a-f0-9]{40}$/));
});

test('managed checkout fetches immutable source with argument-based calls', () => {
  const calls = [];
  ensureSource(SOURCES[0], (command, args, options) => {
    calls.push({ command, args });
    assert.equal(options.shell, undefined);
    return { status: 0 };
  }, () => false, () => {});
  assert.deepEqual(calls[2].args, ['fetch', '--depth', '1', 'origin', SOURCES[0].commit]);
  assert.deepEqual(calls[3].args, ['checkout', '--detach', '--quiet', 'FETCH_HEAD']);
});

test('updating an installed managed revision preserves changes instead of overwriting them', () => {
  const run = (_command, args) => ({ status: 0, stdout: args[0] === 'rev-parse' ? 'old' : ' M instructions.md' });
  assert.throws(() => ensureSource(SOURCES[0], run, () => true), /has changes/);
  assert.throws(() => ensureSource(SOURCES[0], () => assert.fail('must not execute'), p => !p.endsWith('.git')), /exists without/);
});

test('a clean installed checkout can update to a new pin without deleting session data', () => {
  const calls = [];
  ensureSource(SOURCES[0], (_command, args) => {
    calls.push(args);
    return { status: 0, stdout: args[0] === 'rev-parse' ? 'old' : '' };
  }, () => true);
  assert.deepEqual(calls.at(-2), ['fetch', '--depth', '1', 'origin', SOURCES[0].commit]);
  assert.deepEqual(calls.at(-1), ['checkout', '--detach', '--quiet', 'FETCH_HEAD']);
});
