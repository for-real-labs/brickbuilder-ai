const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SOURCES, ensureSource, setup, deploymentDockerfile } = require('../scripts/nova.cjs');
const { startService, install, waitReady, containerName } = require('../scripts/nova.cjs');
const { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');

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

test('Docker is required unless explicitly using Basic bricks or an external runtime', () => {
  assert.throws(() => install(() => ({ status: 1 }), {}), /Docker Desktop/);
  install(() => assert.fail('Basic bricks must not install Docker'), { NOVA_SKIP_SETUP: 'true' });
  install(() => assert.fail('external runtime must not build locally'), { NOVA_SERVICE_URL: 'http://nova:8000', NOVA_SERVICE_TOKEN: 'private' });
  assert.throws(() => install(() => assert.fail('must not spawn'), { NOVA_SERVICE_URL: 'http://nova:8000' }), /both/);
});

for (const running of [true, false]) {
  test(`startup reuses the managed runtime and preserves sessions when running=${running}`, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'nova-start-'));
    writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({url:'http://127.0.0.1:8779',token:'private'}));
    const calls = [];
    const run = (command, args, options) => {
      calls.push({command,args,options});
      if (args[0] === 'image') return {status:0,stdout:'image-id\n'};
      if (args[0] === 'inspect') return {status:0,stdout:JSON.stringify([{Image:'image-id',State:{Running:running},
        HostConfig:{PortBindings:{'8000/tcp':[{HostIp:'127.0.0.1',HostPort:'8779'}]}},Config:{Env:['NOVA_SERVICE_TOKEN=private']}}])};
      return {status:0};
    };
    try {
      startService(run,{NOVA_SERVICE_PORT:'8779'},directory);
      assert.equal(calls.some(call => call.args[0] === 'start'),!running);
      assert.ok(!calls.some(call => ['rm','run','build'].includes(call.args[0])));
      const readiness = calls.at(-1);
      assert.equal(readiness.options.env.NOVA_CHECK_TOKEN,'private');
      assert.ok(!readiness.args.join(' ').includes('private'));
      assert.equal(JSON.parse(readFileSync(path.join(directory,'connection.json'))).token,'private');
      assert.equal(statSync(path.join(directory,'service.env')).mode & 0o777,0o600);
    } finally {rmSync(directory,{recursive:true,force:true});}
  });
}

test('new runtimes use localhost and named volumes and wait for authenticated readiness', () => {
  const directory = mkdtempSync(path.join(tmpdir(),'nova-new-'));
  const calls=[];
  try {
    startService((command,args,options)=>{
      calls.push({command,args,options});
      if (args[0]==='image') return {status:0,stdout:'image-id'};
      if (args[0]==='inspect') return {status:1};
      return {status:0};
    },{NOVA_SERVICE_PORT:'8780'},directory);
    const create=calls.find(call=>call.args[0]==='run');
    assert.ok(create.args.includes('127.0.0.1:8780:8000'));
    assert.ok(create.args.includes(containerName(directory)+'-data:/data'));
    assert.ok(create.args.includes(containerName(directory)+'-config:/config'));
    assert.equal(calls.at(-1).command,process.execPath);
    assert.equal(statSync(path.join(directory,'connection.json')).mode & 0o777,0o600);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('unready Nova prevents API startup instead of silently allowing failed All parts builds', () => {
  assert.throws(()=>waitReady({url:'http://nova:8000',token:'private'},()=>({status:1})),/startup failed/);
});

test('both build contexts include the shared parts policy and use a new integration image tag', () => {
  const setup = readFileSync(path.resolve(__dirname, '../backend/setup_nova.cjs'), 'utf8');
  const ignore = readFileSync(path.resolve(__dirname, '../backend/nova-service/Dockerfile.dockerignore'), 'utf8');
  assert.match(setup, /parts-v1/);
  assert.match(setup, /COPY backend\/src\/utils\/parts_catalog.py/);
  assert.match(setup, /cpSync\(path.join\(__dirname, 'src\/utils\/parts_catalog.py'\)/);
  assert.match(ignore, /!backend\/src\/utils\/parts_catalog.py/);
});
