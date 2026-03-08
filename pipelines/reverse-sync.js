require('dotenv/config');

const { requireProductionServer } = require('../lib/server-check');
const { createSyncLogger } = require('../lib/logger');
const { runReverseSyncMultiPage } = require('../lib/reverse-sync-sportlink');
const { detectChanges } = require('../lib/detect-rondo-club-changes');

/**
 * Run full reverse sync for all fields (Rondo Club -> Sportlink)
 * Syncs contact fields (/general), free fields (/other), and financial toggle (/financial)
 * @param {Object} options
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {Object} [options.logger] - External logger
 * @returns {Promise<{success: boolean, synced: number, failed: number, results: Array}>}
 */
async function runAllFieldsReverseSync(options = {}) {
  const { verbose = false, knvbId = null, logger: providedLogger } = options;
  const logger = providedLogger || createSyncLogger({ verbose, prefix: 'reverse' });

  logger.log('Starting reverse sync (Rondo Club -> Sportlink) for all fields...');
  logger.log('Fields: email, email2, mobile, phone, datum-vog, freescout-id, financiele-blokkade');
  if (knvbId) {
    logger.log(`Target filter: knvb_id = ${knvbId}`);
  }

  try {
    // Detect Rondo Club changes to populate rondo_club_change_detections table
    logger.log('Detecting Rondo Club changes...');
    const detectedChanges = await detectChanges({ verbose, logger, knvbId });
    logger.log(`Detected ${detectedChanges.length} field change(s)`);

    const result = await runReverseSyncMultiPage({ verbose, logger, knvbId });

    if (result.synced === 0 && result.failed === 0) {
      logger.log('No changes to sync');
    } else {
      logger.log(`Reverse sync complete: ${result.synced} members synced, ${result.failed} failed`);
    }

    return result;
  } catch (err) {
    logger.error(`Reverse sync failed: ${err.message}`);
    return { success: false, synced: 0, failed: 0, error: err.message };
  }
}

module.exports = { runAllFieldsReverseSync };

function parseCliArgs(argv) {
  const args = { verbose: false, knvbId: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--verbose') {
      args.verbose = true;
      continue;
    }

    if (arg.startsWith('--knvb-id=')) {
      const value = arg.split('=').slice(1).join('=').trim();
      if (value) args.knvbId = value;
      continue;
    }

    if (arg === '--knvb-id') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('Missing value for --knvb-id');
      }
      args.knvbId = value.trim();
      i++;
      continue;
    }
  }

  return args;
}

// CLI entry point
if (require.main === module) {
  // Prevent accidental local runs - database state safety
  requireProductionServer({
    allowLocal: true,  // Allow with warning for testing
    scriptName: 'reverse-sync.js'
  });

  let cliArgs;
  try {
    cliArgs = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    process.exitCode = 1;
    process.exit();
  }

  runAllFieldsReverseSync(cliArgs)
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
