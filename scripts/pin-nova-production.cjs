const { pinNova } = require('./pin-nova-staging.cjs');

if (require.main === module) {
  try {
    const revisions = pinNova();
    for (const source of revisions) console.log(`${source.name}: ${source.commit}`);
    console.log('Review and commit backend/setup_nova.cjs and backend/nova-service/Dockerfile in a BrickBuilder PR targeting main.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
