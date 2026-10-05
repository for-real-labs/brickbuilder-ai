const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SOURCES, ensureSource, setup, deploymentDockerfile } = require('../scripts/nova.cjs');

test('local setup delegates to the same two-repository runtime installer', () => {
  assert.equal(setup, require('../backend/setup_nova.cjs').setup);
  assert.equal(SOURCES.length, 2);
  assert.match(SOURCES[0].url, /ldraw-nova\.git$/);
  assert.match(SOURCES[1].url, /ldraw-nova-docker\.git$/);
  SOURCES.forEach(source => assert.match(source.commit, /^[a-f0-9]{40}$/));
  SOURCES.forEach(source => assert.match(source.url, /^https:\/\/github\.com\/jjohnson5253\//));
});

test('hosted build imports fork sources without requiring registry credentials or secondary contexts', () => {
  const recipe = deploymentDockerfile('FROM ubuntu:24.04\nCOPY web/backend/ /app/web/backend/\nCOPY --from=nova pyproject.toml uv.lock /opt/ldraw-nova/\nCOPY --from=frontend /src/dist/ /opt/web/static/\nVOLUME ["/data", "/config"]');
  SOURCES.forEach(source => assert.ok(recipe.includes(source.url) && recipe.includes(source.commit)));
  assert.ok(recipe.includes('COPY --from=nova_web /source/web/backend/ /app/web/backend/'));
  assert.ok(recipe.includes('COPY --from=nova /source/pyproject.toml /source/uv.lock /opt/ldraw-nova/'));
  assert.ok(recipe.includes('COPY --from=frontend /src/dist/ /opt/web/static/'));
  assert.ok(recipe.includes('NOVA_BIND_HOST'));
  assert.ok(recipe.includes('COPY backend/src/utils/generation_budget.py /app/web/backend/brickbuilder_integration/generation_budget.py'));
  assert.ok(!recipe.includes('\nVOLUME '));
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
  assert.ok(calls.some(args => args[0] === 'remote' && args[1] === 'set-url' && args[3] === SOURCES[0].url));
});
