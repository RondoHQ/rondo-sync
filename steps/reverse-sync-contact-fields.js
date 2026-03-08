require('dotenv/config');

const { requireProductionServer } = require('../lib/server-check');
const { createSyncLogger } = require('../lib/logger');
const { runReverseSync } = require('../lib/reverse-sync-sportlink');

/**
 * Run contact fields reverse sync (Rondo Club -> Sportlink)
 * @param {Object} options
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<{success: boolean, synced: number, failed: number, results: Array}>}
 */
async function runContactFieldsReverseSync(options = {}) {
  const { verbose = false, knvbId = null, logger: providedLogger } = options;
  const logger = providedLogger || createSyncLogger({ verbose, prefix: 'reverse' });

  logger.log('Starting contact fields reverse sync (Rondo Club -> Sportlink)...');
  if (knvbId) {
    logger.log(`Target filter: knvb_id = ${knvbId}`);
  }

  try {
    const result = await runReverseSync({ verbose, logger, knvbId });

    if (result.synced === 0 && result.failed === 0) {
      logger.log('No contact field changes to sync');
    } else {
      logger.log(`Reverse sync complete: ${result.synced} synced, ${result.failed} failed`);
    }

    return result;
  } catch (err) {
    logger.error(`Reverse sync failed: ${err.message}`);
    return { success: false, synced: 0, failed: 0, error: err.message };
  }
}

module.exports = { runContactFieldsReverseSync };

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
  // Prevent accidental local runs
  requireProductionServer({
    allowLocal: true,
    scriptName: 'reverse-sync-contact-fields.js'
  });

  let cliArgs;
  try {
    cliArgs = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Argument error: ${error.message}`);
    process.exitCode = 1;
    process.exit();
  }

  runContactFieldsReverseSync(cliArgs)
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
