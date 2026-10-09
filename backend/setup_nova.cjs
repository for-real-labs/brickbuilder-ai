const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const runtime = path.join(__dirname, '.nova');
// Upgrade both together, then run the adapter contract and real-runtime smoke tests.
const SOURCES = Object.freeze([
  { name: 'toolkit', url: 'https://github.com/jjohnson5253/ldraw-nova.git', commit: '98eac806bf721d83c9a04d31299050cea8d6d4f9' },
  { name: 'web', url: 'https://github.com/jjohnson5253/ldraw-nova-docker.git', commit: '051dc2115211410cdc538461991ad2d498c18fda' },
]);
const IMAGE = `brickbuilder-nova:${SOURCES[0].commit.slice(0, 12)}-${SOURCES[1].commit.slice(0, 12)}-parts-v1`;
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

function externalRuntime(env) {
  if (env.NOVA_SKIP_SETUP === 'true') {
    console.log('Local Nova setup skipped; All parts needs a running Nova service.');
    return true;
  }
  if (env.NOVA_SERVICE_URL || env.NOVA_SERVICE_TOKEN) {
    if (!env.NOVA_SERVICE_URL || !env.NOVA_SERVICE_TOKEN) throw new Error('Set both NOVA_SERVICE_URL and NOVA_SERVICE_TOKEN for an external runtime.');
    console.log('Using the configured external Nova runtime.');
    return true;
  }
  return false;
}

function requireDocker(run) {
  const result = run('docker', ['info'], { encoding: 'utf8', stdio: 'pipe' });
  if (result.error || result.status !== 0) throw new Error('Nova requires Git and Docker Desktop running. Start Docker Desktop, then run npm install again. For Basic bricks only, set NOVA_SKIP_SETUP=true.');
}

function install(run = spawnSync, env = process.env) {
  if (externalRuntime(env)) return;
  requireDocker(run);
  const { toolkit, web, dockerfile } = prepare(run);
  execute('docker', ['build', '--platform', 'linux/amd64', '--build-context', `nova=${toolkit}`, '-f', dockerfile, '-t', IMAGE, web], runtime, run);
  console.log('Nova fork repositories and Docker dependencies installed. npm start will start the runtime.');
}

function containerName(installation = runtime) {
  return 'brickbuilder-nova-' + require('node:crypto').createHash('sha256').update(installation).digest('hex').slice(0, 8);
}

function waitReady(connection, run = spawnSync, env = process.env) {
  // Pass the private token through the child environment, never command arguments.
  const script = `
    (async () => {
      const deadline = Date.now() + 120000;
      while (Date.now() < deadline) {
        try {
          const response = await fetch(process.env.NOVA_CHECK_URL + '/integration/runtime', {
            headers: {Authorization: 'Bearer ' + process.env.NOVA_CHECK_TOKEN, 'X-Nova-Tenant': '0'.repeat(64)},
            signal: AbortSignal.timeout(3000)
          });
          if (response.ok) { const versions = await response.json();
            if (versions.toolkit && versions.web) { console.log('Nova runtime is ready.'); return; }
          }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      console.error('Nova runtime did not become ready. Check Docker logs and the service connection.');
      process.exitCode = 1;
    })();`;
  const result = run(process.execPath, ['-e', script], { cwd: __dirname, stdio: 'inherit',
    env: { ...env, NOVA_CHECK_URL: connection.url.replace(/\/$/, ''), NOVA_CHECK_TOKEN: connection.token } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Nova runtime startup failed.');
}

function startService(run = spawnSync, env = process.env, installation = runtime) {
  if (externalRuntime(env)) {
    if (env.NOVA_SKIP_SETUP !== 'true') waitReady({ url: env.NOVA_SERVICE_URL, token: env.NOVA_SERVICE_TOKEN }, run, env);
    return;
  }
  requireDocker(run);
  let image = run('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8', stdio: 'pipe' });
  if (image.error || image.status !== 0) {
    install(run, env);
    image = run('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], { encoding: 'utf8', stdio: 'pipe' });
    if (image.error || image.status !== 0) throw new Error('Nova image is unavailable. Run npm install again.');
  }
  const port = Number(env.NOVA_SERVICE_PORT || '8778');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a valid NOVA_SERVICE_PORT');
  mkdirSync(installation, { recursive: true });
  const connectionPath = path.join(installation, 'connection.json');
  const previous = existsSync(connectionPath) ? JSON.parse(readFileSync(connectionPath, 'utf8')) : {};
  const token = previous.token || randomBytes(32).toString('hex');
  const connection = { url: `http://127.0.0.1:${port}`, token };
  const envFile = path.join(installation, 'service.env');
  writeFileSync(envFile, `NOVA_SERVICE_TOKEN=${token}\n`, { mode: 0o600 });
  const container = containerName(installation);
  const inspected = run('docker', ['inspect', container], { encoding: 'utf8', stdio: 'pipe' });
  const existing = inspected.status === 0 ? JSON.parse(inspected.stdout)[0] : null;
  const binding = existing?.HostConfig?.PortBindings?.['8000/tcp']?.[0];
  const reusable = existing?.Image === image.stdout.trim() && binding?.HostIp === '127.0.0.1' && binding?.HostPort === String(port)
    && existing?.Config?.Env?.includes('NOVA_SERVICE_TOKEN=' + token);
  if (reusable) {
    if (!existing.State.Running) execute('docker', ['start', container], runtime, run);
  } else {
    // Replace only this checkout's managed container; preserve both named volumes.
    if (existing) execute('docker', ['rm', '-f', container], runtime, run);
    execute('docker', ['run', '-d', '--platform', 'linux/amd64', '--init', '--name', container, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${port}:8000`, '--env-file', envFile,
      '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${container}-data:/data`, '-v', `${container}-config:/config`, IMAGE], runtime, run);
  }
  writeFileSync(connectionPath, JSON.stringify(connection), { mode: 0o600 });
  waitReady(connection, run, env);
}

function setup(run = spawnSync, env = process.env) {
  install(run, env);
  startService(run, env);
}

function status(run = spawnSync, env = process.env) {
  console.log('Nova fork revisions:', JSON.stringify(Object.fromEntries(SOURCES.map(source => [source.name, source.commit]))));
  if (externalRuntime(env)) return;
  const result = run('docker', ['inspect', containerName(), '--format', '{{.State.Status}}'], { encoding: 'utf8', stdio: 'pipe' });
  console.log('Local Nova runtime:', result.status === 0 ? result.stdout.trim() : 'not installed or Docker is unavailable');
}

if (require.main === module) {
  try { process.argv.includes('--prepare') ? prepare() : setup(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { SOURCES, IMAGE, ensureSource, execute, prepare, install, startService, setup, status, externalRuntime, waitReady, containerName, deploymentDockerfile };
