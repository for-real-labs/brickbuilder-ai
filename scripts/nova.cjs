// Local commands and deployment builds share one upstream runtime lifecycle.
const nova = require('../backend/scripts/nova-runtime.cjs');

if (require.main === module) nova.main();

module.exports = nova;
