const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const runtime = path.join(__dirname, '.nova');
// Upgrade both together, then run the adapter contract and real-runtime smoke tests.
const SOURCES = Object.freeze([
  { name: 'toolkit', url: 'https://github.com/anteloc/ldraw-nova.git', commit: '5919d2289e023eeacc2ffc03cbe750e447a024dd' },
  { name: 'web', url: 'https://github.com/anteloc/ldraw-nova-docker.git', commit: '947a5a36e2e5d5f2a04b9da32d2ae6b8a364886f' },
]);
const IMAGE = `brickbuilder-nova:${SOURCES[0].commit.slice(0, 12)}-${SOURCES[1].commit.slice(0, 12)}`;

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
    if (revision === source.commit) return destination;
    if (execute('git', ['status', '--porcelain', '--untracked-files=no'], destination, run, true)) {
      throw new Error(`The managed ${source.name} checkout has changes. Preserve them before updating Nova.`);
    }
  } else {
    if (exists(destination)) throw new Error(`${destination} exists without its source checkout. Move it aside and run setup:nova again.`);
    mkdir(destination, { recursive: true });
    execute('git', ['init', '--quiet'], destination, run);
    execute('git', ['remote', 'add', 'origin', source.url], destination, run);
  }
  execute('git', ['fetch', '--depth', '1', 'origin', source.commit], destination, run);
  execute('git', ['checkout', '--detach', '--quiet', 'FETCH_HEAD'], destination, run);
  return destination;
}

function prepare(run = spawnSync) {
  mkdirSync(runtime, { recursive: true });
  const toolkit = ensureSource(SOURCES[0], run);
  const web = ensureSource(SOURCES[1], run);
  const integration = path.join(web, 'brickbuilder-integration');
  cpSync(path.join(__dirname, 'nova-service'), integration, { recursive: true });
  writeFileSync(path.join(integration, 'versions.json'), JSON.stringify(Object.fromEntries(SOURCES.map(s => [s.name, s.commit]))));
  // Build upstream's actual Dockerfile, including its renderer, sandbox and SDKs.
  // Append only the private gateway; no copies of upstream app/toolkit code live here.
  const dockerfile = path.join(runtime, 'Dockerfile.service');
  writeFileSync(dockerfile, readFileSync(path.join(web, 'Dockerfile'), 'utf8') + '\n' +
    'COPY brickbuilder-integration/ /app/web/backend/brickbuilder_integration/\n' +
    'RUN chmod -R a-w /opt/ldraw-nova/ldraw_tools\n' +
    'CMD ["uvicorn", "brickbuilder_integration.gateway:app", "--app-dir", "/app/web/backend", "--host", "0.0.0.0", "--port", "8000"]\n');
  return { toolkit, web, dockerfile };
}

function setup(run = spawnSync, env = process.env) {
  const { toolkit, web, dockerfile } = prepare(run);
  execute('docker', ['build', '--platform', 'linux/amd64', '--build-arg', 'MPD2GLB_SHA256=381fb275c9f974820620ef4e4ec8b5be84ea8306a9f1ccd95bc75beaa8139f34', '--build-context', `nova=${toolkit}`, '-f', dockerfile, '-t', IMAGE, web], runtime, run);
  const port = Number(env.NOVA_SERVICE_PORT || '8778');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid NOVA_SERVICE_PORT');
  const connectionPath = path.join(runtime, 'connection.json');
  const previous = existsSync(connectionPath) ? JSON.parse(readFileSync(connectionPath, 'utf8')) : {};
  const token = previous.token || randomBytes(32).toString('hex');
  const connection = { url: `http://127.0.0.1:${port}`, token };
  writeFileSync(connectionPath, JSON.stringify(connection), { mode: 0o600 });
  const envFile = path.join(runtime, 'service.env');
  writeFileSync(envFile, `NOVA_SERVICE_TOKEN=${token}\n`, { mode: 0o600 });
  const container = 'brickbuilder-nova-' + require('node:crypto').createHash('sha256').update(runtime).digest('hex').slice(0, 8);
  // Stop only the container owned by this managed installation; retain its volumes.
  run('docker', ['rm', '-f', container], { stdio: 'ignore' });
  execute('docker', ['run', '-d', '--init', '--name', container, '--restart', 'unless-stopped',
    '-p', `127.0.0.1:${port}:8000`, '--env-file', envFile,
    '-v', `${container}-data:/data`, '-v', `${container}-config:/config`, IMAGE], runtime, run);
  console.log('Nova runtime installed. Run npm start and choose Nova mode.');
}

if (require.main === module) {
  try { process.argv.includes('--prepare') ? prepare() : setup(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { SOURCES, IMAGE, ensureSource, execute, prepare, setup };
