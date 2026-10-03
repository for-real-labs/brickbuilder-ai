const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const backend = path.resolve(__dirname, '..');
const SOURCES = Object.freeze([
  { name: 'toolkit', url: 'https://github.com/anteloc/ldraw-nova.git' },
  { name: 'jev', url: 'https://github.com/anteloc/jev-rerank.git' },
]);
const SHA = /^[a-f0-9]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PROCESS_ENVIRONMENT = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'LDRAW_DIR',
  'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_NATIVE_TLS', 'UV_OFFLINE', 'UV_INDEX_URL',
  'UV_EXTRA_INDEX_URL', 'PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_CERT', 'PIP_CLIENT_CERT', 'PIP_TRUSTED_HOST',
]);

function subprocessEnvironment(env) {
  return Object.fromEntries(PROCESS_ENVIRONMENT.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

function execute(command, args, cwd, run = spawnSync, capture = true, options = {}) {
  const result = run(command, args, {
    cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    maxBuffer: 8 * 1024 * 1024, timeout: 120000, ...options,
  });
  // Subprocess output may include credentials from a user's package-manager configuration.
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed${result.error?.code === 'ETIMEDOUT' ? ' (timed out)' : ''}.`);
  return result.stdout?.trim() || '';
}

function context(options = {}) {
  const backendRoot = path.resolve(options.backendRoot || backend);
  return {
    run: options.run || spawnSync, env: options.env || process.env,
    platform: options.platform || process.platform, backendRoot,
    runtime: path.join(backendRoot, '.nova'), log: options.log || console.log,
  };
}

function settings(ctx) {
  const result = { ...ctx.env };
  // Read only local updater settings, never provider keys, and honor the process environment.
  try {
    for (const line of fs.readFileSync(path.join(ctx.backendRoot, '.env'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(NOVA_AUTO_UPDATE|NOVA_TOOLKIT_ROOT|NOVA_PYTHON|NOVA_SETUP_PYTHON|NOVA_GIT_TIMEOUT_SECONDS|NOVA_GIT_FETCH_TIMEOUT_SECONDS|LDRAW_DIR)\s*=\s*(.*?)\s*$/);
      if (!match || result[match[1]] !== undefined) continue;
      let value = match[2];
      if (/^["']/.test(value)) {
        const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
        if (!quoted) throw new Error('Invalid quoted updater setting.');
        value = quoted[2];
      } else value = value.replace(/\s+#.*$/, '').trim();
      result[match[1]] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Unable to read local Nova updater settings.');
  }
  return result;
}

function gitOptions(ctx, download = false) {
  const defaultSeconds = download ? 600 : 15;
  const seconds = Number(ctx.env[download ? 'NOVA_GIT_FETCH_TIMEOUT_SECONDS' : 'NOVA_GIT_TIMEOUT_SECONDS'] || defaultSeconds);
  return {
    timeout: Number.isFinite(seconds) ? Math.max(1000, Math.min(download ? 900000 : 60000, seconds * 1000)) : defaultSeconds * 1000,
    env: { ...subprocessEnvironment(ctx.env), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  };
}

function latestSource(source, ctx) {
  const output = execute('git', ['ls-remote', '--symref', source.url, 'HEAD'], ctx.backendRoot, ctx.run, true, gitOptions(ctx));
  const branch = output.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
  const revision = output.match(/^([a-f0-9]{40})\tHEAD$/m)?.[1];
  if (!branch || !BRANCH.test(branch) || branch.includes('..') || !revision) throw new Error(`Unable to discover the ${source.name} default branch.`);
  return { ...source, branch, revision };
}

function sourceState(destination, source, ctx) {
  if (!fs.existsSync(path.join(destination, '.git'))) return null;
  try {
    const revision = execute('git', ['rev-parse', 'HEAD'], destination, ctx.run, true, gitOptions(ctx));
    const remote = execute('git', ['remote', 'get-url', 'origin'], destination, ctx.run, true, gitOptions(ctx));
    const dirty = execute('git', ['status', '--porcelain', '--untracked-files=normal'], destination, ctx.run, true, gitOptions(ctx));
    if (!SHA.test(revision) || remote !== source.url || dirty) return null;
    return { revision };
  } catch { return null; }
}

function ensureSource(source, destination, ctx) {
  // Destination must be a newly allocated snapshot. Existing user checkouts are never changed.
  if (fs.existsSync(destination)) throw new Error(`Refusing to replace an existing ${source.name} checkout.`);
  fs.mkdirSync(destination, { recursive: true });
  execute('git', ['init', '--quiet'], destination, ctx.run, true, gitOptions(ctx));
  execute('git', ['remote', 'add', 'origin', source.url], destination, ctx.run, true, gitOptions(ctx));
  const active = readManifest(ctx);
  const caches = [...new Set([active?.[source.name === 'toolkit' ? 'toolkit' : 'jev'], path.join(ctx.runtime, source.name)].filter(Boolean))];
  for (const cache of caches) {
    const objects = path.join(cache, '.git', 'objects');
    const state = fs.existsSync(objects) ? sourceState(cache, source, ctx) : null;
    if (!state) continue;
    // Older snapshots are retained. Reuse their immutable Git objects so a
    // one-line upstream update does not transfer the entire model corpus.
    const info = path.join(destination, '.git', 'objects', 'info');
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, 'alternates'), path.resolve(objects) + '\n', { mode: 0o600 });
    const shallow = path.join(cache, '.git', 'shallow');
    if (fs.existsSync(shallow)) fs.copyFileSync(shallow, path.join(destination, '.git', 'shallow'));
    execute('git', ['update-ref', 'refs/brickbuilder/cache', state.revision], destination, ctx.run, true, gitOptions(ctx));
    break;
  }
  execute('git', ['fetch', '--depth', '1', 'origin', `refs/heads/${source.branch}`], destination, ctx.run, true, gitOptions(ctx, true));
  execute('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], destination, ctx.run, true, gitOptions(ctx, true));
  const state = sourceState(destination, source, ctx);
  if (!state) throw new Error(`The fetched ${source.name} checkout is not clean.`);
  return { root: destination, revision: state.revision, branch: source.branch };
}

function relativePath(root, value, allowLeafSymlink = false) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.split('/').some(p => !p || p === '.' || p === '..')) return null;
  const resolved = path.resolve(root, value);
  if (!resolved.startsWith(root + path.sep)) return null;
  try {
    const confined = allowLeafSymlink ? path.dirname(resolved) : resolved;
    if (!fs.existsSync(resolved) || !fs.realpathSync(confined).startsWith(fs.realpathSync(root) + path.sep)) return null;
  } catch { return null; }
  return resolved;
}

function readManifest(ctx) {
  try {
    const file = path.join(ctx.runtime, 'runtime.json');
    const stats = fs.lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 65536) return null;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (manifest.schema_version !== 1 || !SHA.test(manifest.toolkit_revision) || !SHA.test(manifest.jev_revision)
      || !BRANCH.test(manifest.toolkit_branch || '') || !BRANCH.test(manifest.jev_branch || '')) return null;
    const toolkit = relativePath(ctx.runtime, manifest.toolkit_root);
    const python = relativePath(ctx.runtime, manifest.python, true);
    const jev = relativePath(ctx.runtime, manifest.jev_root);
    if (!toolkit || !python || !jev || !python.startsWith(toolkit + path.sep)
      || !fs.realpathSync(path.dirname(python)).startsWith(fs.realpathSync(toolkit) + path.sep)) return null;
    return { manifest, toolkit, python, jev };
  } catch { return null; }
}

function legacyRuntime(ctx) {
  const toolkit = path.join(ctx.runtime, 'toolkit');
  const jev = path.join(ctx.runtime, 'jev');
  const python = path.join(toolkit, '.venv', ctx.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!relativePath(ctx.runtime, 'toolkit') || !relativePath(ctx.runtime, 'jev')
    || !relativePath(ctx.runtime, `toolkit/.venv/${ctx.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`, true)) return null;
  const toolkitState = sourceState(toolkit, SOURCES[0], ctx);
  const jevState = sourceState(jev, SOURCES[1], ctx);
  return toolkitState && jevState ? { toolkit, jev, python, toolkitRevision: toolkitState.revision, jevRevision: jevState.revision } : null;
}

function findPython(run = spawnSync, env = process.env) {
  const candidates = env.NOVA_SETUP_PYTHON ? [env.NOVA_SETUP_PYTHON] : ['python3.14', 'python3.13', 'python3.12', 'python3'];
  for (const command of candidates) {
    const result = run(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'], { stdio: 'ignore', timeout: 10000, env: subprocessEnvironment(env) });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error('Nova needs Python 3.12+. Install it or install uv, then run npm run setup:nova.');
}

function installDependencies(toolkit, jev, ctx) {
  const python = path.join(toolkit, '.venv', ctx.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const uv = ctx.run('uv', ['--version'], { stdio: 'ignore', timeout: 10000, env: subprocessEnvironment(ctx.env) });
  const opts = { timeout: 900000, env: subprocessEnvironment(ctx.env) };
  if (!uv.error && uv.status === 0) {
    execute('uv', ['sync', '--frozen', '--no-dev', '--python', ctx.env.NOVA_SETUP_PYTHON || '3.14'], toolkit, ctx.run, true, opts);
    execute('uv', ['pip', 'install', '--python', python, jev], toolkit, ctx.run, true, opts);
  } else {
    execute(findPython(ctx.run, ctx.env), ['-m', 'venv', '.venv'], toolkit, ctx.run, true, opts);
    execute(python, ['-m', 'pip', 'install', toolkit, jev], toolkit, ctx.run, true, opts);
  }
  return python;
}

function libraryRoot(ctx) {
  const python = path.join(ctx.backendRoot, '.venv', ctx.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) throw new Error('Run npm install before setup:nova to install the backend environment.');
  const output = execute(python, ['-c',
    'import os; from src.utils.pack_ldraw_model import LDrawPacker; p=LDrawPacker(os.environ.get("LDRAW_DIR")); assert (p.ldraw_path/"LDConfig.ldr").is_file(); print(p.ldraw_path.resolve())'], ctx.backendRoot, ctx.run, true, { env: subprocessEnvironment(ctx.env) });
  const library = output.split(/\r?\n/).at(-1);
  if (!path.isAbsolute(library || '')) throw new Error('Unable to locate the official LDraw library.');
  return library;
}

function parseReport(output, label) {
  try { return JSON.parse(output); } catch { throw new Error(`${label} returned an invalid report.`); }
}

function validateRuntime(runtime, library, ctx, index = true) {
  const bridge = path.join(ctx.backendRoot, 'src/utils/nova_runtime_bridge.py');
  const probe = parseReport(execute(runtime.python, [bridge, '--toolkit-root', runtime.toolkit, '--library', library, '--operation', 'manifest'], ctx.backendRoot, ctx.run, true, { env: subprocessEnvironment(ctx.env) }), 'Nova runtime probe');
  if (probe.schema_version !== 1 || probe.compatible !== true || probe.contract?.compatible !== true || !Array.isArray(probe.capabilities)) throw new Error('Nova runtime compatibility check failed.');
  execute(path.join(path.dirname(runtime.python), ctx.platform === 'win32' ? 'jev-rerank.exe' : 'jev-rerank'), ['--help'], runtime.toolkit, ctx.run, true, { env: subprocessEnvironment(ctx.env) });
  const cli = args => execute(runtime.python, ['-m', 'ldraw_tools.cli', '--library', library, ...args], runtime.toolkit, ctx.run, true, { timeout: 600000, env: subprocessEnvironment(ctx.env) });
  if (index) { cli(['index']); cli(['discover', 'index']); }
  // No API calls, image generation, or desktop CAD dependencies during validation.
  const search = parseReport(cli(['discover', 'search', 'submodels', 'tower roof', '--engine', 'fts', '--limit', '1', '--all-families']), 'Nova reference search');
  if (!Array.isArray(search.results)) throw new Error('Nova reference search compatibility check failed.');
  const directory = fs.mkdtempSync(path.join(ctx.runtime, 'validation-'));
  try {
    const planPath = path.join(directory, 'smoke.plan.json');
    const modelPath = path.join(directory, 'smoke.mpd');
    fs.writeFileSync(planPath, JSON.stringify({ version: 1, author: 'BrickBuilder runtime validation', sections: [
      { name: 'main.ldr', description: 'Runtime smoke test', steps: [[{ id: 'brick', ref: '3001.dat', colour: 4, at: [0, 0, 0] }]] },
    ] }));
    const build = parseReport(cli(['build', planPath, '--output', modelPath, '--force', '--detail', 'summary', '--contacts', 'auto', '--limit', '10', '--max-instances', '10']), 'Nova plan compilation');
    if (build.checks_passed !== true || build.written !== true || !fs.existsSync(modelPath)) throw new Error('Nova plan compilation compatibility check failed.');
    const reference = search.results.find(row => /^submodel-[a-f0-9]{24}$/.test(row.id || ''));
    if (!reference) throw new Error('Nova bundled reference compatibility check failed.');
    const output = path.join(directory, 'reference');
    const extracted = parseReport(execute(runtime.python, [path.join(ctx.backendRoot, 'src/utils/nova_reference_bridge.py'),
      '--toolkit-root', runtime.toolkit, '--library', library, '--reference', reference.id,
      '--max-instances', '10000', '--output', output], ctx.backendRoot, ctx.run, true,
    { env: subprocessEnvironment(ctx.env) }), 'Nova reference extraction');
    if (extracted.written !== true || extracted.id !== reference.id) throw new Error('Nova reference extraction compatibility check failed.');
    const metadata = parseReport(fs.readFileSync(path.join(output, 'metadata.json'), 'utf8'), 'Nova reference metadata');
    if (metadata.id !== reference.id || !Array.isArray(metadata.inventory?.bom) || !metadata.inventory.bom.length
      || !Array.isArray(metadata.attribution) || !metadata.attribution.length) throw new Error('Nova reference inventory compatibility check failed.');
    for (const name of ['source.mpd', 'preview.mpd']) {
      const size = fs.statSync(path.join(output, name)).size;
      if (!size || size > 3000000) throw new Error('Nova reference geometry compatibility check failed.');
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  return probe.capabilities.filter(item => item.available).map(item => item.id).filter(item => typeof item === 'string');
}

function activate(runtime, capabilities, ctx, validatedAt = new Date().toISOString()) {
  const manifest = {
    schema_version: 1,
    toolkit_root: path.relative(ctx.runtime, runtime.toolkit).split(path.sep).join('/'),
    python: path.relative(ctx.runtime, runtime.python).split(path.sep).join('/'),
    jev_root: path.relative(ctx.runtime, runtime.jev).split(path.sep).join('/'),
    toolkit_revision: runtime.toolkitRevision, toolkit_branch: runtime.toolkitBranch,
    jev_revision: runtime.jevRevision, jev_branch: runtime.jevBranch,
    validated_at: validatedAt, capabilities,
  };
  const temporary = path.join(ctx.runtime, `runtime-${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(manifest, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, path.join(ctx.runtime, 'runtime.json'));
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return manifest;
}

function lockRuntime(ctx) {
  const file = path.join(ctx.runtime, 'update.lock');
  try {
    const fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw new Error('Unable to lock the Nova updater.');
    // A crashed updater should not permanently prevent future checks.
    let owner;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')).pid; } catch { /* Invalid locks remain untouched. */ }
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); } catch (probe) {
        if (probe.code === 'ESRCH') { fs.unlinkSync(file); return lockRuntime(ctx); }
      }
    }
    throw new Error('A Nova update is already in progress.');
  }
  return () => fs.unlinkSync(file);
}

function update(options = {}) {
  const ctx = context(options);
  ctx.env = settings(ctx);
  if (ctx.env.NOVA_TOOLKIT_ROOT || ctx.env.NOVA_PYTHON) throw new Error('Custom Nova runtime configured. Remove NOVA_TOOLKIT_ROOT and NOVA_PYTHON to use managed updates.');
  fs.mkdirSync(ctx.runtime, { recursive: true });
  if (fs.lstatSync(ctx.runtime).isSymbolicLink()) throw new Error('Managed Nova runtime directory must not be a symlink.');
  const unlock = lockRuntime(ctx);
  let candidate;
  try {
    const latest = SOURCES.map(source => latestSource(source, ctx));
    const active = readManifest(ctx);
    if (active && active.manifest.toolkit_revision === latest[0].revision && active.manifest.jev_revision === latest[1].revision
      && sourceState(active.toolkit, SOURCES[0], ctx)?.revision === latest[0].revision
      && sourceState(active.jev, SOURCES[1], ctx)?.revision === latest[1].revision) {
      let manifest = active.manifest;
      if (options.validateCurrent || manifest.toolkit_branch !== latest[0].branch || manifest.jev_branch !== latest[1].branch) {
        const selected = {
          ...active, toolkitRevision: manifest.toolkit_revision, jevRevision: manifest.jev_revision,
          toolkitBranch: latest[0].branch, jevBranch: latest[1].branch,
        };
        const capabilities = options.validateCurrent ? validateRuntime(selected, libraryRoot(ctx), ctx, false) : manifest.capabilities || [];
        manifest = activate(selected, capabilities, ctx, options.validateCurrent ? new Date().toISOString() : manifest.validated_at);
      }
      ctx.log(`Nova is current (${manifest.toolkit_branch}, ${latest[0].revision.slice(0, 12)}).`);
      return { status: 'current', manifest };
    }
    const library = libraryRoot(ctx);
    const legacy = !active && legacyRuntime(ctx);
    if (legacy && legacy.toolkitRevision === latest[0].revision && legacy.jevRevision === latest[1].revision) {
      const capabilities = validateRuntime(legacy, library, ctx, false);
      const manifest = activate({ ...legacy, toolkitBranch: latest[0].branch, jevBranch: latest[1].branch }, capabilities, ctx);
      ctx.log('Existing Nova installation validated and enabled for managed updates.');
      return { status: 'adopted', manifest };
    }
    const snapshot = path.join(ctx.runtime, 'snapshots');
    fs.mkdirSync(snapshot, { recursive: true });
    if (fs.lstatSync(snapshot).isSymbolicLink()) throw new Error('Managed Nova snapshot directory must not be a symlink.');
    candidate = fs.mkdtempSync(path.join(snapshot, 'runtime-'));
    ctx.log('Preparing latest Nova and Jev in an isolated runtime.');
    const toolkit = ensureSource(latest[0], path.join(candidate, 'toolkit'), ctx);
    const jev = ensureSource(latest[1], path.join(candidate, 'jev'), ctx);
    const python = installDependencies(toolkit.root, jev.root, ctx);
    const runtime = {
      toolkit: toolkit.root, jev: jev.root, python,
      toolkitRevision: toolkit.revision, toolkitBranch: toolkit.branch,
      jevRevision: jev.revision, jevBranch: jev.branch,
    };
    const capabilities = validateRuntime(runtime, library, ctx);
    const manifest = activate(runtime, capabilities, ctx);
    candidate = null; // Activated snapshots are retained for any in-flight generations.
    ctx.log(`Nova ready (${manifest.toolkit_branch}, ${manifest.toolkit_revision.slice(0, 12)}). New generations use this runtime; existing builds keep their starting version.`);
    return { status: 'updated', manifest };
  } finally {
    if (candidate) fs.rmSync(candidate, { recursive: true, force: true });
    unlock();
  }
}

function setup(options = {}) { return update({ ...options, validateCurrent: true }); }

function status(options = {}) {
  const ctx = context(options);
  ctx.env = settings(ctx);
  if (ctx.env.NOVA_TOOLKIT_ROOT || ctx.env.NOVA_PYTHON) return { status: 'custom', auto_update: false };
  const active = readManifest(ctx);
  const auto_update = ctx.env.NOVA_AUTO_UPDATE?.toLowerCase() !== 'false';
  if (active) return { status: 'ready', auto_update, ...active.manifest };
  if (legacyRuntime(ctx)) return { status: 'legacy', auto_update };
  return { status: 'not_installed', auto_update };
}

function autoUpdate(options = {}) {
  const ctx = context(options);
  try {
    ctx.env = settings(ctx);
    if (ctx.env.NOVA_AUTO_UPDATE?.toLowerCase() === 'false' || ctx.env.NOVA_TOOLKIT_ROOT || ctx.env.NOVA_PYTHON) return { status: 'skipped' };
    // Starting the ordinary builder never triggers the optional 1 GB Nova bootstrap.
    if (!readManifest(ctx) && !legacyRuntime(ctx)) return { status: 'not_installed' };
    return update({ ...options, env: ctx.env });
  } catch {
    ctx.log('Nova update unavailable or incompatible; retaining the existing runtime. Use npm run update:nova to retry.');
    return { status: 'retained' };
  }
}

function main(arguments = process.argv.slice(2)) {
  try {
    if (arguments[0] === 'status') console.log(JSON.stringify(status(), null, 2));
    else if (!arguments[0] || arguments[0] === 'setup') setup();
    else if (arguments[0] === 'update') update();
    else if (arguments[0] === 'auto') autoUpdate();
    else throw new Error('Expected setup, update, auto, or status.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (require.main === module) main();

module.exports = { SOURCES, execute, latestSource, ensureSource, findPython, readManifest, setup, update, status, autoUpdate, main };
