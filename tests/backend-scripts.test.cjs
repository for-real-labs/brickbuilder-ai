const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { environmentPython, findPython, install, start } = require('../scripts/backend.cjs');

test('selects a supported Python after rejecting missing and older interpreters', () => {
  const attempted = [];
  const python = findPython((command) => {
    attempted.push(command);
    return { status: command === 'python3.11' ? 0 : 1 };
  }, {}, 'linux');
  assert.equal(python.command, 'python3.11');
  assert.equal(attempted.length, 3);
});

test('honors explicit Python paths, including spaces, without using a shell', () => {
  const python = findPython((command, args, options) => {
    assert.equal(command, '/custom Python/python');
    assert.equal(args[0], '-c');
    assert.equal(options.shell, undefined);
    return { status: 0 };
  }, { PYTHON: '/custom Python/python' });
  assert.equal(python.command, '/custom Python/python');
});

test('unsupported explicit Python produces actionable guidance', () => {
  assert.throws(() => findPython(() => ({ status: 1 }), { PYTHON: 'old-python' }), /Python 3.10\+/);
});

test('Windows can discover Python through the py launcher', () => {
  const python = findPython((command) => ({ status: command === 'py' ? 0 : 1 }), {}, 'win32');
  assert.deepEqual(python, { command: 'py', args: ['-3'] });
  assert.equal(environmentPython('win32'), path.resolve(__dirname, '../backend/.venv/Scripts/python.exe'));
});

test('installation creates a venv and installs pinned dependencies and editable project', () => {
  const calls = [];
  install((command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  }, { PYTHON: 'python3' }, 'linux');
  assert.deepEqual(calls.slice(1).map(({ args }) => args), [
    ['-m', 'venv', '.venv'],
    ['-m', 'ensurepip', '--upgrade'],
    ['-m', 'pip', 'install', '-r', 'requirements.txt'],
    ['-m', 'pip', 'install', '--no-deps', '-e', '.'],
  ]);
  for (const call of calls.slice(1)) assert.equal(call.options.cwd, path.resolve(__dirname, '../backend'));
  for (const call of calls.slice(2)) assert.equal(call.command, environmentPython('linux'));
});

test('installation stops immediately if dependency installation fails', () => {
  let calls = 0;
  assert.throws(() => install((command, args) => {
    calls += 1;
    return { status: args.includes('requirements.txt') ? 1 : 0 };
  }, { PYTHON: 'python3' }), /failed/);
  assert.equal(calls, 4);
});

test('startup requires the environment and propagates server failure', () => {
  assert.throws(() => start(() => assert.fail('must not spawn'), () => false), /npm install/);
  assert.throws(() => start((command, args, options) => {
    assert.equal(command, environmentPython());
    assert.deepEqual(args, ['local_run.py']);
    assert.equal(options.cwd, path.resolve(__dirname, '../backend'));
    return { status: 2 };
  }, () => true, () => {}), /failed \(2\)/);
});


test('local startup ensures Nova is ready before launching the backend', () => {
  const order = [];
  const env = { NOVA_SERVICE_PORT: '8779' };
  start((command, args) => {
    order.push('server');
    assert.deepEqual(args, ['local_run.py']);
    return { status: 0 };
  }, () => true, options => {
    order.push('update');
    assert.equal(options.env, env);
    assert.equal(typeof options.run, 'function');
  }, env);
  assert.deepEqual(order, ['update', 'server']);
});
