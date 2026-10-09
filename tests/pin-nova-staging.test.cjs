const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { SOURCES } = require('../backend/setup_nova.cjs');
const { branchRevision, stagingRevision, pinNova, pinStaging } = require('../scripts/pin-nova-staging.cjs');

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'nova-pins-'));
  const setup = path.join(root, 'backend/setup_nova.cjs');
  const dockerfile = path.join(root, 'backend/nova-service/Dockerfile');
  mkdirSync(path.dirname(dockerfile), { recursive: true });
  const original = readFileSync(path.resolve(__dirname, '../backend/setup_nova.cjs'), 'utf8');
  writeFileSync(setup, original);
  writeFileSync(dockerfile, 'original recipe');
  return { root, setup, dockerfile, original };
}

test('resolves only the staging branch of the configured Nova fork', () => {
  const source = stagingRevision(SOURCES[0], (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['ls-remote', '--exit-code', SOURCES[0].url, 'refs/heads/staging']);
    assert.equal(options.shell, undefined);
    return { status: 0, stdout: 'a'.repeat(40) + '\trefs/heads/staging\n' };
  });
  assert.equal(source.commit, 'a'.repeat(40));
  assert.equal(source.url, SOURCES[0].url);
  for (const stdout of ['bad\trefs/heads/staging', 'a'.repeat(40) + '\trefs/heads/master',
    'a'.repeat(40) + '\trefs/heads/staging\n' + 'b'.repeat(40) + '\trefs/heads/staging']) {
    assert.throws(() => stagingRevision(SOURCES[0], () => ({ status: 0, stdout })), /Invalid staging revision/);
  }
});

test('production resolves both customized branches to immutable pins without changing build ownership', () => {
  const files = fixture();
  let calls = 0;
  try {
    const revisions = pinNova({ root: files.root, run: (command, args, options) => {
      if (command === 'git') {
        const source = SOURCES[calls++];
        assert.deepEqual(args, ['ls-remote', '--exit-code', source.url, 'refs/heads/main-BrickBuilderAI']);
        return { status: 0, stdout: (calls === 1 ? 'a' : 'b').repeat(40) + '\trefs/heads/main-BrickBuilderAI\n' };
      }
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['scripts/nova.cjs', '--prepare']);
      assert.equal(options.cwd, files.root);
      writeFileSync(files.dockerfile, 'production recipe');
      return { status: 0 };
    } });
    assert.deepEqual(revisions.map(source => source.commit), ['a'.repeat(40), 'b'.repeat(40)]);
    assert.equal(readFileSync(files.dockerfile, 'utf8'), 'production recipe');
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

test('production rejects another branch and leaves the original pair untouched if either branch is unavailable', () => {
  assert.throws(() => branchRevision(SOURCES[0], 'main-BrickBuilderAI', () => ({
    status: 0, stdout: 'a'.repeat(40) + '\trefs/heads/master\n',
  })), /Invalid main-BrickBuilderAI revision/);
  const files = fixture();
  let calls = 0;
  try {
    assert.throws(() => pinNova({ root: files.root, run: () => ++calls === 1
      ? { status: 0, stdout: 'a'.repeat(40) + '\trefs/heads/main-BrickBuilderAI' } : { status: 2 } }), /Unable to read/);
    assert.equal(readFileSync(files.setup, 'utf8'), files.original);
    assert.equal(readFileSync(files.dockerfile, 'utf8'), 'original recipe');
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

test('updates both immutable pins and regenerates the deployment recipe', () => {
  const files = fixture();
  let calls = 0;
  try {
    const revisions = pinStaging({ root: files.root, run: (command, args, options) => {
      if (command === 'git') return { status: 0, stdout: (++calls === 1 ? 'a' : 'b').repeat(40) + '\trefs/heads/staging' };
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['scripts/nova.cjs', '--prepare']);
      assert.equal(options.cwd, files.root);
      const updated = readFileSync(files.setup, 'utf8');
      assert.ok(updated.includes(`commit: '${'a'.repeat(40)}'`));
      assert.ok(updated.includes(`commit: '${'b'.repeat(40)}'`));
      writeFileSync(files.dockerfile, 'new recipe');
      return { status: 0 };
    } });
    assert.deepEqual(revisions.map(source => source.commit), ['a'.repeat(40), 'b'.repeat(40)]);
    assert.equal(readFileSync(files.dockerfile, 'utf8'), 'new recipe');
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

test('an unavailable second staging branch leaves the original pair untouched', () => {
  const files = fixture();
  let calls = 0;
  try {
    assert.throws(() => pinStaging({ root: files.root, run: () => ++calls === 1
      ? { status: 0, stdout: 'a'.repeat(40) + '\trefs/heads/staging' } : { status: 2 } }), /Unable to read/);
    assert.equal(readFileSync(files.setup, 'utf8'), files.original);
    assert.equal(readFileSync(files.dockerfile, 'utf8'), 'original recipe');
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

test('a failed preparation restores both pins and the previous deployment recipe', () => {
  const files = fixture();
  try {
    assert.throws(() => pinStaging({ root: files.root, run: command => {
      if (command === 'git') return { status: 0, stdout: 'a'.repeat(40) + '\trefs/heads/staging' };
      writeFileSync(files.dockerfile, 'partial recipe');
      return { status: 1 };
    } }), /Pins restored/);
    assert.equal(readFileSync(files.setup, 'utf8'), files.original);
    assert.equal(readFileSync(files.dockerfile, 'utf8'), 'original recipe');
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});
