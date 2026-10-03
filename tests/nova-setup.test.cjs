const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { SOURCES, latestSource, findPython, setup, update, status, autoUpdate, readManifest } = require('../scripts/nova.cjs');

const REVISIONS = { toolkit: 'a'.repeat(40), jev: 'b'.repeat(40) };
const PREVIOUS = { toolkit: 'c'.repeat(40), jev: 'd'.repeat(40) };

function fixture(t, config = {}) {
  const backendRoot = fs.mkdtempSync(path.join(tmpdir(), 'brickbuilder-nova-'));
  t.after(() => fs.rmSync(backendRoot, { recursive: true, force: true }));
  const runtime = path.join(backendRoot, '.nova');
  fs.mkdirSync(path.join(backendRoot, '.venv/bin'), { recursive: true });
  fs.writeFileSync(path.join(backendRoot, '.venv/bin/python'), 'backend python');
  fs.mkdirSync(runtime);
  const calls = [], messages = [], checkouts = new Map();
  const options = { backendRoot, env: {}, platform: 'linux', log: message => messages.push(message) };
  const createSource = (name, directory, revision) => {
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'source.txt'), `${name} ${revision}`);
    checkouts.set(directory, { name, revision });
    if (name === 'toolkit') {
      fs.mkdirSync(path.join(directory, '.venv/bin'), { recursive: true });
      for (const executable of ['python', 'jev-rerank']) fs.writeFileSync(path.join(directory, '.venv/bin', executable), executable);
    }
  };
  const manifestFor = (toolkit, jev, revisions = PREVIOUS) => ({
    schema_version: 1, toolkit_root: path.relative(runtime, toolkit), jev_root: path.relative(runtime, jev),
    python: path.relative(runtime, path.join(toolkit, '.venv/bin/python')),
    toolkit_revision: revisions.toolkit, jev_revision: revisions.jev,
    toolkit_branch: 'master', jev_branch: 'main', validated_at: '2026-10-03T00:00:00Z', capabilities: ['build'],
  });
  const legacy = revisions => {
    const toolkit = path.join(runtime, 'toolkit'), jev = path.join(runtime, 'jev');
    createSource('toolkit', toolkit, revisions.toolkit); createSource('jev', jev, revisions.jev);
    return { toolkit, jev };
  };
  const active = (revisions = PREVIOUS) => {
    const root = path.join(runtime, 'snapshots/previous');
    const toolkit = path.join(root, 'toolkit'), jev = path.join(root, 'jev');
    createSource('toolkit', toolkit, revisions.toolkit); createSource('jev', jev, revisions.jev);
    const manifest = manifestFor(toolkit, jev, revisions);
    fs.writeFileSync(path.join(runtime, 'runtime.json'), JSON.stringify(manifest));
    return { toolkit, jev, manifest };
  };
  options.run = (command, args, settings = {}) => {
    calls.push({ command, args, settings });
    assert.equal(settings.shell, undefined);
    const failure = config.fail?.(command, args, settings);
    if (failure) return { status: 1, stdout: 'private-key', stderr: 'private-key', error: failure === true ? undefined : failure };
    if (command === 'git') {
      if (args[0] === 'ls-remote') {
        const name = SOURCES.find(source => source.url === args[2]).name;
        return { status: 0, stdout: `ref: refs/heads/${config.branches?.[name] || (name === 'toolkit' ? 'master' : 'main')}\tHEAD\n${REVISIONS[name]}\tHEAD` };
      }
      const name = path.basename(settings.cwd);
      if (args[0] === 'init') createSource(name, settings.cwd, REVISIONS[name]);
      if (args[0] === 'rev-parse') return { status: 0, stdout: checkouts.get(settings.cwd).revision };
      if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: config.customRemote?.(settings.cwd) || SOURCES.find(source => source.name === name).url };
      if (args[0] === 'status') return { status: 0, stdout: config.dirty?.(settings.cwd) ? ' M source.txt' : '' };
    }
    if (command.endsWith('/.venv/bin/python') && args[0] === '-c') return { status: 0, stdout: '/library with spaces/ldraw' };
    if (args.includes('--operation')) return { status: 0, stdout: JSON.stringify(config.probe || { schema_version: 1, compatible: true, contract: { compatible: true, missing: [] }, capabilities: [{ id: 'build', available: true }, { id: 'render', available: false }] }) };
    if (args.includes('--reference')) {
      const output = args[args.indexOf('--output') + 1];
      const id = args[args.indexOf('--reference') + 1];
      fs.mkdirSync(output, { recursive: true });
      fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify({ id, inventory: { bom: [{ part: '3001.dat', count: 1 }] }, attribution: [{ author: 'test', license: 'CCAL' }] }));
      fs.writeFileSync(path.join(output, 'source.mpd'), 'source geometry');
      fs.writeFileSync(path.join(output, 'preview.mpd'), 'preview geometry');
      return { status: 0, stdout: JSON.stringify({ written: true, id }) };
    }
    if (args.includes('ldraw_tools.cli')) {
      if (args.includes('search')) return { status: 0, stdout: JSON.stringify({ results: [{ id: 'submodel-' + 'a'.repeat(24) }] }) };
      if (args.includes('build')) {
        fs.writeFileSync(args[args.indexOf('--output') + 1], '0 FILE main.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat');
        return { status: 0, stdout: JSON.stringify({ checks_passed: true, written: true }) };
      }
      return { status: 0, stdout: '{}' };
    }
    return { status: 0, stdout: '' };
  };
  return { options, runtime, calls, messages, active, legacy, manifestFor, checkouts };
}

test('discovers actual default branches, including main and master, without shell or unbounded network calls', t => {
  const f = fixture(t);
  const discovered = SOURCES.map(source => latestSource(source, {
    ...f.options, backendRoot: f.options.backendRoot,
  }));
  assert.deepEqual(discovered.map(source => source.branch), ['master', 'main']);
  for (const call of f.calls) {
    assert.deepEqual(call.args.slice(0, 2), ['ls-remote', '--symref']);
    assert.equal(call.settings.timeout, 15000);
    assert.equal(call.settings.env.GIT_TERMINAL_PROMPT, '0');
  }
  assert.throws(() => latestSource(SOURCES[0], { ...f.options, run: () => ({ status: 0, stdout: 'ref: refs/heads/--unsafe\tHEAD' }) }), /default branch/);
});

test('explicit Nova Python is validated without shell interpolation', () => {
  assert.equal(findPython((command, args) => {
    assert.equal(command, '/Python with spaces/python');
    assert.match(args[1], /3, 12/);
    return { status: 0 };
  }, { NOVA_SETUP_PYTHON: '/Python with spaces/python' }), '/Python with spaces/python');
  assert.throws(() => findPython(() => ({ status: 1 }), {}), /Python 3.12\+/);
});

test('setup installs latest clean sources at final paths, validates real functionality, then activates', t => {
  const f = fixture(t);
  const result = setup(f.options);
  assert.equal(result.status, 'updated');
  assert.equal(result.manifest.toolkit_branch, 'master');
  assert.equal(result.manifest.jev_branch, 'main');
  assert.equal(result.manifest.toolkit_revision, REVISIONS.toolkit);
  assert.match(result.manifest.toolkit_root, /^snapshots\/runtime-[A-Za-z0-9]+\/toolkit$/);
  assert.deepEqual(result.manifest.capabilities, ['build']);
  assert.equal(status(f.options).status, 'ready');
  assert.ok(f.calls.some(call => call.command === 'uv' && call.args.includes('--frozen')));
  assert.ok(f.calls.some(call => call.args.slice(-2).join(' ') === 'discover index'));
  assert.ok(f.calls.some(call => call.command.endsWith('jev-rerank') && call.args[0] === '--help'));
  assert.ok(f.calls.some(call => call.args.includes('--operation') && call.args.at(-1) === 'manifest'));
  assert.ok(f.calls.some(call => call.args.includes('build') && call.args.includes('--max-instances')));
  assert.ok(f.calls.every(call => !call.args.includes('leocad')));
  assert.equal(fs.statSync(path.join(f.runtime, 'runtime.json')).mode & 0o777, 0o600);
  const installPath = f.calls.find(call => call.command === 'uv' && call.args[0] === 'sync').settings.cwd;
  assert.equal(installPath, path.join(f.runtime, result.manifest.toolkit_root));
  assert.ok(f.calls.some(call => call.args[0] === 'fetch' && call.args.at(-1) === 'refs/heads/master'));
});

test('current managed runtime checks latest without cloning, reinstalling or changing the selector', t => {
  const f = fixture(t);
  f.active(REVISIONS);
  const before = fs.readFileSync(path.join(f.runtime, 'runtime.json'), 'utf8');
  assert.equal(update(f.options).status, 'current');
  assert.equal(fs.readFileSync(path.join(f.runtime, 'runtime.json'), 'utf8'), before);
  assert.ok(f.calls.every(call => call.command === 'git'));
});

test('clean current legacy runtime is validated and adopted without moving its venv', t => {
  const f = fixture(t);
  f.legacy(REVISIONS);
  assert.equal(status(f.options).status, 'legacy');
  const result = autoUpdate(f.options);
  assert.equal(result.status, 'adopted');
  assert.equal(result.manifest.toolkit_root, 'toolkit');
  assert.equal(result.manifest.python, 'toolkit/.venv/bin/python');
  assert.ok(f.calls.every(call => call.command !== 'uv'));
});

for (const stage of ['network', 'fetch', 'install', 'probe', 'search', 'compile', 'reference']) {
  test(`${stage} failure leaves the previous active runtime byte-for-byte intact and removes failed candidate`, t => {
    const f = fixture(t, { fail: (command, args) => (
      (stage === 'network' && args[0] === 'ls-remote') ||
      (stage === 'fetch' && args[0] === 'fetch') ||
      (stage === 'install' && command === 'uv' && args[0] === 'sync') ||
      (stage === 'probe' && args.includes('--operation')) ||
      (stage === 'search' && args.includes('ldraw_tools.cli') && args.includes('search')) ||
      (stage === 'compile' && args.includes('ldraw_tools.cli') && args.includes('build')) ||
      (stage === 'reference' && args.includes('--reference'))
    ) });
    const active = f.active();
    const before = fs.readFileSync(path.join(f.runtime, 'runtime.json'), 'utf8');
    assert.throws(() => update(f.options), error => !error.message.includes('private-key'));
    assert.equal(fs.readFileSync(path.join(f.runtime, 'runtime.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(active.toolkit, 'source.txt'), 'utf8'), `toolkit ${PREVIOUS.toolkit}`);
    assert.deepEqual(fs.readdirSync(path.join(f.runtime, 'snapshots')), ['previous']);
    assert.ok(!fs.existsSync(path.join(f.runtime, 'update.lock')));
  });
}

test('malformed or incompatible probe never replaces the old runtime', t => {
  const f = fixture(t, { probe: { schema_version: 1, compatible: true, contract: { compatible: false }, capabilities: [] } });
  f.active();
  assert.throws(() => update(f.options), /compatibility check failed/);
  assert.equal(status(f.options).toolkit_revision, PREVIOUS.toolkit);
});

test('automatic update failure keeps local startup usable and reports no raw subprocess output', t => {
  const f = fixture(t, { fail: (_command, args) => args[0] === 'ls-remote' });
  f.active();
  assert.equal(autoUpdate(f.options).status, 'retained');
  assert.match(f.messages.at(-1), /retaining/);
  assert.ok(f.messages.every(message => !message.includes('private-key')));
});

test('updates activate atomically after validation and retain the previous snapshot for running jobs', t => {
  const f = fixture(t);
  const previous = f.active();
  const rename = fs.renameSync;
  let activated = false;
  fs.renameSync = (from, to) => {
    assert.equal(JSON.parse(fs.readFileSync(to, 'utf8')).toolkit_revision, PREVIOUS.toolkit);
    assert.ok(f.calls.some(call => call.args.includes('build')));
    activated = true;
    return rename(from, to);
  };
  try {
    const result = update(f.options);
    assert.ok(activated);
    assert.notEqual(result.manifest.toolkit_root, previous.manifest.toolkit_root);
    assert.ok(fs.existsSync(previous.toolkit));
    assert.equal(status(f.options).toolkit_revision, REVISIONS.toolkit);
  } finally { fs.renameSync = rename; }
});

test('dirty legacy or custom checkouts are preserved and never adopted or updated at startup', t => {
  const f = fixture(t, { dirty: directory => directory === path.join(f.runtime, 'toolkit') });
  const old = f.legacy(REVISIONS);
  const before = fs.readFileSync(path.join(old.toolkit, 'source.txt'), 'utf8');
  assert.equal(autoUpdate(f.options).status, 'not_installed');
  assert.ok(f.calls.every(call => call.args[0] !== 'ls-remote'));
  const result = update(f.options);
  assert.equal(result.status, 'updated');
  assert.notEqual(result.manifest.toolkit_root, 'toolkit');
  assert.equal(fs.readFileSync(path.join(old.toolkit, 'source.txt'), 'utf8'), before);
});

test('origin mismatch is never treated as a managed legacy installation', t => {
  const f = fixture(t, { customRemote: () => 'https://example.com/custom.git' });
  f.legacy(REVISIONS);
  assert.equal(autoUpdate(f.options).status, 'not_installed');
  assert.ok(!fs.existsSync(path.join(f.runtime, 'runtime.json')));
});

test('startup does not bootstrap Nova for ordinary builder users', t => {
  const f = fixture(t);
  assert.equal(autoUpdate(f.options).status, 'not_installed');
  assert.equal(f.calls.length, 0);
});

test('process settings and local .env opt-outs preserve custom runtimes', t => {
  const f = fixture(t);
  f.active(REVISIONS);
  for (const env of [{ NOVA_AUTO_UPDATE: 'false' }, { NOVA_AUTO_UPDATE: 'FALSE' }, { NOVA_TOOLKIT_ROOT: '/custom' }, { NOVA_PYTHON: '/custom/python' }]) {
    assert.equal(autoUpdate({ ...f.options, env }).status, 'skipped');
  }
  assert.throws(() => update({ ...f.options, env: { NOVA_TOOLKIT_ROOT: '/custom' } }), /Custom Nova runtime/);
  fs.writeFileSync(path.join(f.options.backendRoot, '.env'), 'TYPESAFE_API_KEY=private-key\nNOVA_AUTO_UPDATE="false" # disable automatic updates\n');
  assert.equal(autoUpdate(f.options).status, 'skipped');
  assert.equal(status(f.options).auto_update, false);
  assert.equal(autoUpdate({ ...f.options, env: { NOVA_AUTO_UPDATE: 'true' } }).status, 'current');
});

test('runtime selector rejects traversal and directory symlink escape but accepts venv interpreter symlinks', t => {
  const f = fixture(t);
  const active = f.active();
  const file = path.join(f.runtime, 'runtime.json');
  const ctx = { ...f.options, runtime: f.runtime };
  fs.writeFileSync(file, JSON.stringify({ ...active.manifest, python: '../outside/python' }));
  assert.equal(readManifest(ctx), null);
  fs.writeFileSync(file, JSON.stringify(active.manifest));
  const executable = path.join(active.toolkit, '.venv/bin/python');
  fs.unlinkSync(executable);
  const external = path.join(f.options.backendRoot, '.venv/bin/python');
  fs.symlinkSync(external, executable);
  assert.ok(readManifest(ctx));
  const outside = path.join(f.options.backendRoot, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.runtime, 'escaped'));
  fs.writeFileSync(file, JSON.stringify({ ...active.manifest, jev_root: 'escaped' }));
  assert.equal(readManifest(ctx), null);
});

test('another live updater is not interrupted or allowed to race activation', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.runtime, 'update.lock'), JSON.stringify({ pid: process.pid }));
  assert.throws(() => update(f.options), /already in progress/);
  assert.equal(f.calls.length, 0);
  assert.ok(fs.existsSync(path.join(f.runtime, 'update.lock')));
});

test('invalid subprocess JSON reports a safe stage name without echoing its content', t => {
  const f = fixture(t);
  f.active();
  const run = f.options.run;
  f.options.run = (command, args, options) => args.includes('--operation')
    ? { status: 0, stdout: 'private-key invalid JSON' } : run(command, args, options);
  assert.throws(() => update(f.options), error => error.message === 'Nova runtime probe returned an invalid report.');
  assert.equal(status(f.options).toolkit_revision, PREVIOUS.toolkit);
});

test('updater never passes provider, database, storage or TypeSafe credentials to upstream code', t => {
  const f = fixture(t);
  f.options.env = {
    PATH: '/safe/bin', HOME: '/safe/home', HTTPS_PROXY: 'https://network-proxy', SSL_CERT_FILE: '/safe/ca.pem',
    OPENAI_API_KEY: 'private-key', ANTHROPIC_API_KEY: 'private-key', TYPESAFE_API_KEY: 'private-key',
    FAL_KEY: 'private-key', DATABASE_URL: 'private-key', SUPABASE_SERVICE_ROLE_KEY: 'private-key', GITHUB_TOKEN: 'private-key',
  };
  update(f.options);
  for (const call of f.calls) {
    assert.equal(call.settings.env.OPENAI_API_KEY, undefined);
    assert.equal(call.settings.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(call.settings.env.TYPESAFE_API_KEY, undefined);
    assert.equal(call.settings.env.FAL_KEY, undefined);
    assert.equal(call.settings.env.DATABASE_URL, undefined);
    assert.equal(call.settings.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
    assert.equal(call.settings.env.GITHUB_TOKEN, undefined);
    assert.equal(call.settings.env.PATH, '/safe/bin');
    assert.equal(call.settings.env.SSL_CERT_FILE, '/safe/ca.pem');
  }
});

test('activation records fetched HEAD if the upstream branch advances after discovery', t => {
  const f = fixture(t);
  const actual = 'e'.repeat(40);
  const run = f.options.run;
  f.options.run = (command, args, options) => {
    const result = run(command, args, options);
    if (command === 'git' && args[0] === 'fetch' && options.cwd.endsWith('toolkit')) f.checkouts.get(options.cwd).revision = actual;
    return result;
  };
  assert.equal(update(f.options).manifest.toolkit_revision, actual);
  assert.equal(status(f.options).toolkit_revision, actual);
});

test('runtime selector rejects oversized files, symlink manifests, and a venv parent in another snapshot', t => {
  const f = fixture(t);
  const active = f.active();
  const ctx = { ...f.options, runtime: f.runtime };
  const file = path.join(f.runtime, 'runtime.json');
  fs.writeFileSync(file, ' '.repeat(65537));
  assert.equal(readManifest(ctx), null);
  fs.unlinkSync(file);
  const otherFile = path.join(f.options.backendRoot, 'selector.json');
  fs.writeFileSync(otherFile, JSON.stringify(active.manifest));
  fs.symlinkSync(otherFile, file);
  assert.equal(readManifest(ctx), null);
  fs.unlinkSync(file);
  fs.writeFileSync(file, JSON.stringify(active.manifest));
  const otherBin = path.join(f.runtime, 'snapshots/another/toolkit/.venv/bin');
  fs.mkdirSync(otherBin, { recursive: true });
  fs.writeFileSync(path.join(otherBin, 'python'), 'another interpreter');
  fs.rmSync(path.join(active.toolkit, '.venv/bin'), { recursive: true });
  fs.symlinkSync(otherBin, path.join(active.toolkit, '.venv/bin'));
  assert.equal(readManifest(ctx), null);
});

test('local updater configuration read failures cannot prevent backend startup', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.options.backendRoot, '.env'));
  assert.equal(autoUpdate(f.options).status, 'retained');
  assert.equal(f.calls.length, 0);
});


test('a renamed default branch refreshes tracking metadata without cloning or revalidating sources', t => {
  const f = fixture(t, { branches: { toolkit: 'main', jev: 'main' } });
  const previous = f.active(REVISIONS);
  const result = update(f.options);
  assert.equal(result.status, 'current');
  assert.equal(result.manifest.toolkit_branch, 'main');
  assert.equal(result.manifest.validated_at, previous.manifest.validated_at);
  assert.equal(result.manifest.toolkit_root, previous.manifest.toolkit_root);
  assert.ok(f.calls.every(call => call.command === 'git'));
});

test('setup revalidates an unchanged selected runtime without moving or reinstalling it', t => {
  const f = fixture(t);
  const previous = f.active(REVISIONS);
  const result = setup(f.options);
  assert.equal(result.status, 'current');
  assert.equal(result.manifest.toolkit_root, previous.manifest.toolkit_root);
  assert.ok(f.calls.some(call => call.args.includes('--reference')));
  assert.ok(f.calls.every(call => call.command !== 'uv'));
});


test('quoted local Python paths and opt-outs support inline comments and export declarations', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.options.backendRoot, '.env'), 'export NOVA_AUTO_UPDATE="false" # stay current\nNOVA_SETUP_PYTHON="/Python with spaces/python" # optional override\n');
  assert.equal(autoUpdate(f.options).status, 'skipped');
  setup(f.options);
  const sync = f.calls.find(call => call.command === 'uv' && call.args[0] === 'sync');
  assert.equal(sync.args[sync.args.indexOf('--python') + 1], '/Python with spaces/python');
});

test('large source downloads have a separate bounded timeout from HEAD discovery', t => {
  const f = fixture(t);
  update(f.options);
  assert.ok(f.calls.filter(call => call.args[0] === 'ls-remote').every(call => call.settings.timeout === 15000));
  assert.ok(f.calls.filter(call => call.args[0] === 'fetch').every(call => call.settings.timeout === 600000));
  assert.ok(f.calls.filter(call => call.args[0] === 'checkout').every(call => call.settings.timeout === 600000));
  const configured = fixture(t);
  configured.options.env = { NOVA_GIT_TIMEOUT_SECONDS: '3', NOVA_GIT_FETCH_TIMEOUT_SECONDS: '9999' };
  update(configured.options);
  assert.ok(configured.calls.filter(call => call.args[0] === 'ls-remote').every(call => call.settings.timeout === 3000));
  assert.ok(configured.calls.filter(call => call.args[0] === 'fetch').every(call => call.settings.timeout === 900000));
});

test('new snapshots reuse clean retained Git objects without changing the previous checkout', t => {
  const f = fixture(t);
  const previous = f.active();
  for (const root of [previous.toolkit, previous.jev]) {
    fs.mkdirSync(path.join(root, '.git/objects'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git/shallow'), PREVIOUS[path.basename(root)] + '\n');
  }
  const before = fs.readFileSync(path.join(previous.toolkit, 'source.txt'), 'utf8');
  const result = update(f.options);
  const selected = path.join(f.runtime, result.manifest.toolkit_root);
  assert.equal(fs.readFileSync(path.join(selected, '.git/objects/info/alternates'), 'utf8'), path.join(previous.toolkit, '.git/objects') + '\n');
  assert.equal(fs.readFileSync(path.join(selected, '.git/shallow'), 'utf8'), PREVIOUS.toolkit + '\n');
  assert.equal(fs.readFileSync(path.join(previous.toolkit, 'source.txt'), 'utf8'), before);
  assert.ok(f.calls.some(call => call.settings.cwd === selected && call.args.join(' ') === `update-ref refs/brickbuilder/cache ${PREVIOUS.toolkit}`));
});

test('dirty Git caches are ignored when preparing a new snapshot', t => {
  let previous;
  const f = fixture(t, { dirty: cwd => cwd === previous?.toolkit });
  previous = f.active();
  fs.mkdirSync(path.join(previous.toolkit, '.git/objects'), { recursive: true });
  const result = update(f.options);
  const selected = path.join(f.runtime, result.manifest.toolkit_root);
  assert.equal(fs.existsSync(path.join(selected, '.git/objects/info/alternates')), false);
  assert.equal(fs.readFileSync(path.join(previous.toolkit, 'source.txt'), 'utf8'), `toolkit ${PREVIOUS.toolkit}`);
});
