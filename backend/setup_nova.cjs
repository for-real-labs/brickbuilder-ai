const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const runtime = path.join(__dirname, '.nova');
// Upgrade both together, then run the adapter contract and real-runtime smoke tests.
const SOURCES = Object.freeze([
  { name: 'toolkit', url: 'https://github.com/jjohnson5253/ldraw-nova.git', commit: 'c4ba6c4913e0975ee7e34e647c26129137657d5e' },
  { name: 'web', url: 'https://github.com/jjohnson5253/ldraw-nova-docker.git', commit: '46a6ffd35d9bb342d43a687b8c614b4a873f79e4' },
]);
const IMAGE = `brickbuilder-nova:${SOURCES[0].commit.slice(0, 12)}-${SOURCES[1].commit.slice(0, 12)}`;
const SERVICE_CMD = 'CMD ["sh", "-c", "exec uvicorn brickbuilder_integration.gateway:app --app-dir /app/web/backend --host ${NOVA_BIND_HOST:-0.0.0.0} --port 8000"]\n';

function deploymentDockerfile(upstream) {
  // Railway builds with one repository context. Import the pinned forks in
  // source stages, then retain the fork's build recipe and runtime unchanged.
  const sources = SOURCES.map(source => `FROM alpine:3.22 AS ${source.name === 'toolkit' ? 'nova' : 'nova_web'}\n` +
    `RUN apk add --no-cache git && git init /source && cd /source && git remote add origin ${source.url} && git fetch --depth 1 origin ${source.commit} && git checkout --detach FETCH_HEAD\n`).join('\n');
  const recipe = upstream.split('\n').map(line => {
    // Railway owns volume attachment and rejects Docker VOLUME declarations.
    if (line.startsWith('VOLUME ')) return '# Persistent storage is supplied by the Railway /data volume.';
    if (!line.startsWith('COPY ')) return line;
    if (line.endsWith('\\') || line.includes('[')) throw new Error('Review the new upstream COPY syntax before deploying Nova');
    const args = line.split(/\s+/);
    const fromToolkit = args[1] === '--from=nova';
    if (args[1].startsWith('--') && !fromToolkit) return line;
    const paths = args.slice(fromToolkit ? 2 : 1, -1).map(value => '/source/' + value);
    return `COPY --from=${fromToolkit ? 'nova' : 'nova_web'} ${paths.join(' ')} ${args.at(-1)}`;
  }).join('\n');
  const versions = JSON.stringify(Object.fromEntries(SOURCES.map(s => [s.name, s.commit])));
  return '# Generated from the pinned Nova forks by backend/setup_nova.cjs.\n' + sources + '\n' + recipe + '\n' +
    'COPY backend/nova-service/ /app/web/backend/brickbuilder_integration/\n' +
    'COPY backend/src/utils/generation_budget.py /app/web/backend/brickbuilder_integration/generation_budget.py\n' +
    `RUN printf '%s' '${versions}' > /app/web/backend/brickbuilder_integration/versions.json && chmod -R a-w /opt/ldraw-nova/ldraw_tools\n` + SERVICE_CMD;
}

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
    if (revision === source.commit) {
      execute('git', ['remote', 'set-url', 'origin', source.url], destination, run);
      return destination;
    }
    if (execute('git', ['status', '--porcelain', '--untracked-files=no'], destination, run, true)) {
      throw new Error(`The managed ${source.name} checkout has changes. Preserve them before updating Nova.`);
    }
    execute('git', ['remote', 'set-url', 'origin', source.url], destination, run);
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
  cpSync(path.join(__dirname, 'src/utils/generation_budget.py'), path.join(integration, 'generation_budget.py'));
  writeFileSync(path.join(integration, 'versions.json'), JSON.stringify(Object.fromEntries(SOURCES.map(s => [s.name, s.commit]))));
  // Build upstream's actual Dockerfile, including its renderer, sandbox and SDKs.
  // Append only the private gateway; no copies of upstream app/toolkit code live here.
  const dockerfile = path.join(runtime, 'Dockerfile.service');
  writeFileSync(dockerfile, readFileSync(path.join(web, 'Dockerfile'), 'utf8') + '\n' +
    'COPY brickbuilder-integration/ /app/web/backend/brickbuilder_integration/\n' +
    'RUN chmod -R a-w /opt/ldraw-nova/ldraw_tools\n' +
    SERVICE_CMD);
  writeFileSync(path.join(__dirname, 'nova-service/Dockerfile'), deploymentDockerfile(readFileSync(path.join(web, 'Dockerfile'), 'utf8')));
  return { toolkit, web, dockerfile };
}

function setup(run = spawnSync, env = process.env) {
  const { toolkit, web, dockerfile } = prepare(run);
  execute('docker', ['build', '--platform', 'linux/amd64', '--build-context', `nova=${toolkit}`, '-f', dockerfile, '-t', IMAGE, web], runtime, run);
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
module.exports = { SOURCES, IMAGE, ensureSource, execute, prepare, setup, deploymentDockerfile };
