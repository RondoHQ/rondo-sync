/**
 * Server environment check
 *
 * Prevents accidental sync runs from non-production environments
 * to avoid database state mismatches that cause duplicates.
 */

const os = require('os');

const PRODUCTION_HOSTNAME = 'srv1-rondo-club';

/**
 * Check if running on the production server
 * @returns {boolean}
 */
function isProductionServer() {
  return os.hostname() === PRODUCTION_HOSTNAME;
}

/**
 * Require production server or exit
 * Call this at the start of sync scripts to prevent local runs
 *
 * @param {Object} options
 * @param {boolean} options.allowLocal - Allow local runs with --allow-local flag
 * @param {string} options.scriptName - Name of the script for error message
 */
function requireProductionServer(options = {}) {
  const { allowLocal = false, scriptName = 'This sync script' } = options;

  if (isProductionServer()) {
    return true;
  }

  // Check if --allow-local flag is present
  if (allowLocal && process.argv.includes('--allow-local')) {
    console.warn('');
    console.warn('WARNING: Running sync locally with --allow-local flag');
    console.warn('This can cause duplicate entries if the local database is out of sync!');
    console.warn('');
    return true;
  }

  console.error('');
  console.error('ERROR: Cannot run sync from local machine');
  console.error('');
  console.error(`${scriptName} must run on the production server (${PRODUCTION_HOSTNAME})`);
  console.error('to prevent database state mismatches that cause duplicate entries.');
  console.error('');
  console.error('To sync, SSH to the server and run from there:');
  console.error('  ssh srv1.rondo');
  console.error('  sudo -u rondo-sync -H bash');
  console.error('  cd /srv/rondo-sync');
  console.error('  npm run sync-all');
  console.error('');
  console.error('If you really need to run locally (dangerous!), use --allow-local');
  console.error('');

  process.exit(1);
}

module.exports = {
  isProductionServer,
  requireProductionServer,
  PRODUCTION_HOSTNAME
};
