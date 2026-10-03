const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../backend');
const runtime = path.join(backend, '.nova');
const SOURCES = Object.freeze([
  { name: 'toolkit', url: 'https://github.com/anteloc/ldraw-nova.git', commit: 'c4ba6c4913e0975ee7e34e647c26129137657d5e' },
  { name: 'jev', url: 'https://github.com/anteloc/jev-rerank.git', commit: 'afe4045cddcf5684e43a7db68bc5f9a19f900dcc' },
]);

function execute(command, args, cwd, run = spawnSync, capture = false) {
  const result = run(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal}).`);
  return result.stdout?.trim() || '';
}

function ensureSource(source, run = spawnSync, exists = existsSync, mkdir = mkdirSync) {
  const destination = path.join(runtime, source.name);
  if (exists(path.join(destination, '.git'))) {
    const revision = execute('git', ['rev-parse', 'HEAD'], destination, run, true);
    if (revision !== source.commit) throw new Error(`Unexpected ${source.name} revision. Move ${destination} aside and run setup:nova again.`);
    return destination;
  }
  if (exists(destination)) throw new Error(`${destination} exists without its source checkout. Move it aside and run setup:nova again.`);
  mkdir(destination, { recursive: true });
  execute('git', ['init', '--quiet'], destination, run);
  execute('git', ['remote', 'add', 'origin', source.url], destination, run);
  execute('git', ['fetch', '--depth', '1', 'origin', source.commit], destination, run);
  execute('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], destination, run);
  return destination;
}

function findPython(run = spawnSync, env = process.env) {
  const candidates = env.NOVA_SETUP_PYTHON ? [env.NOVA_SETUP_PYTHON] : ['python3.14', 'python3.13', 'python3.12', 'python3'];
  for (const command of candidates) {
    const result = run(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return command;
  }
  throw new Error('Nova needs Python 3.12+. Install it or install uv (which provisions Python), then run npm run setup:nova.');
}

function setup(run = spawnSync, env = process.env, platform = process.platform, exists = existsSync, mkdir = mkdirSync) {
  mkdir(runtime, { recursive: true });
  const toolkit = ensureSource(SOURCES[0], run, exists, mkdir);
  const jev = ensureSource(SOURCES[1], run, exists, mkdir);
  const uv = run('uv', ['--version'], { stdio: 'ignore' });
  const executable = path.join(toolkit, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!uv.error && uv.status === 0) {
    execute('uv', ['sync', '--frozen', '--no-dev', '--python', env.NOVA_SETUP_PYTHON || '3.14'], toolkit, run);
    execute('uv', ['pip', 'install', '--python', executable, jev], toolkit, run);
  } else {
    execute(findPython(run, env), ['-m', 'venv', '.venv'], toolkit, run);
    execute(executable, ['-m', 'pip', 'install', toolkit, jev], toolkit, run);
  }
  // Reuse BrickBuilder's official parts-library installer; no desktop CAD tools.
  const backendPython = path.join(backend, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!exists(backendPython)) throw new Error('Run npm install before setup:nova to install the backend environment.');
  const library = execute(backendPython, ['-c',
    'import os; from src.utils.pack_ldraw_model import LDrawPacker; p=LDrawPacker(os.environ.get("LDRAW_DIR")); assert (p.ldraw_path/"LDConfig.ldr").is_file(); print(p.ldraw_path.resolve())'], backend, run, true).split(/\r?\n/).at(-1);
  execute(executable, ['-m', 'ldraw_tools.cli', '--library', library, 'index'], toolkit, run);
  execute(executable, ['-m', 'ldraw_tools.cli', '--library', library, 'discover', 'index'], toolkit, run);
  console.log('Nova and Jev are ready. Run npm start, then choose Full set agent on the landing page.');
}

if (require.main === module) {
  try { setup(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { SOURCES, ensureSource, execute, findPython, setup };
