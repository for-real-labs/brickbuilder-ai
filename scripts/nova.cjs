const nova = require('../backend/setup_nova.cjs');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

function localEnvironment(env = process.env) {
  const file = path.resolve(__dirname, '../backend/.env');
  return { ...(existsSync(file) ? require('dotenv').parse(readFileSync(file)) : {}), ...env };
}

function ensureRuntime({ run, env = process.env } = {}) {
  return nova.startService(run, localEnvironment(env));
}

if (require.main === module) {
  try {
    if (process.argv.includes('--prepare')) nova.prepare();
    else {
    const env = localEnvironment();
    if (process.argv[2] === 'install') nova.install(undefined, env);
    else if (process.argv[2] === 'start') ensureRuntime({ env });
    else if (process.argv[2] === 'status') nova.status(undefined, env);
    else if (['setup', 'update', undefined].includes(process.argv[2])) nova.setup(undefined, env);
    else throw new Error('Expected install, start, setup, update, status, or --prepare.');
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { ...nova, ensureRuntime, localEnvironment };
