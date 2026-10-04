const nova = require('../backend/setup_nova.cjs');
if (require.main === module) {
  try { process.argv.includes('--prepare') ? nova.prepare() : nova.setup(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = nova;
