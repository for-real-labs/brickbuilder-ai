const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { ensureRuntime } = require('./nova.cjs');

const backend = path.resolve(__dirname, '../backend');

function environmentPython(platform = process.platform) {
  return path.join(backend, '.venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function findPython(run = spawnSync, env = process.env, platform = process.platform) {
  const candidates = env.PYTHON ? [[env.PYTHON]] : [
    [environmentPython(platform)],
    ...['python3.12', 'python3.11', 'python3.10', 'python3.13', 'python3', 'python'].map((name) => [name]),
    ...(platform === 'win32' ? [['py', '-3']] : []),
  ];
  for (const [command, ...args] of candidates) {
    const result = run(command, [...args, '-c',
      'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return { command, args };
  }
  throw new Error('Python 3.10+ is required. Install Python or set PYTHON to its executable path, then run npm install again.');
}

function execute(command, args, run = spawnSync) {
  const result = run(command, args, { cwd: backend, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal || result.status}).`);
}

function install(run = spawnSync, env = process.env, platform = process.platform) {
  const python = findPython(run, env, platform);
  execute(python.command, [...python.args, '-m', 'venv', '.venv'], run);
  const executable = environmentPython(platform);
  execute(executable, ['-m', 'ensurepip', '--upgrade'], run);
  execute(executable, ['-m', 'pip', 'install', '-r', 'requirements.txt'], run);
  execute(executable, ['-m', 'pip', 'install', '--no-deps', '-e', '.'], run);
}

function start(run = spawnSync, exists = existsSync, startNova = ensureRuntime, env = process.env) {
  const executable = environmentPython();
  if (!exists(executable)) throw new Error('Backend environment is missing. Run npm install first.');
  startNova({ run, env });
  execute(executable, ['local_run.py'], run);
}

if (require.main === module) {
  try {
    if (process.argv[2] === 'install') install();
    else if (process.argv[2] === 'start') start();
    else throw new Error('Expected install or start.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { environmentPython, findPython, install, start };
