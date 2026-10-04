// Share the pinned runtime installer with Railway's backend-only build context.
const nova = require('../backend/setup_nova.cjs');

if (require.main === module) {
  try { nova.setup(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = nova;
