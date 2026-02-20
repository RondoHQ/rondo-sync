require('dotenv/config');

const { rondoClubRequestWithRetry } = require('../lib/rondo-club-client');
const { openDb, getActiveTrackedMembers, getAllActiveMemberFunctions } = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');

/**
 * Submit capability sync requests to Rondo Club REST API.
 * For each tracked member with a KNVB ID, sends their active Functies
 * to POST /rondo/v1/capability-sync so WordPress can reconcile roles.
 *
 * Members without a provisioned WP user get a 200 { status: 'no_user' }
 * response — counted as skipped, not errors.
 */
async function runCapabilitySync(options = {}) {
  const { logger, verbose = false } = options;
  const log = logger || createSyncLogger({ verbose, prefix: 'capability-sync' });
  const result = { success: true, total: 0, synced: 0, skipped: 0, errors: [] };

  const db = openDb();
  try {
    const members = getActiveTrackedMembers(db);
    const allFunctions = getAllActiveMemberFunctions(db);

    // Build map: knvb_id => [function_description, ...]
    const functiesByKnvb = {};
    for (const f of allFunctions) {
      if (!functiesByKnvb[f.knvb_id]) functiesByKnvb[f.knvb_id] = [];
      functiesByKnvb[f.knvb_id].push(f.function_description);
    }

    result.total = members.length;
    log.verbose(`Syncing capabilities for ${members.length} members...`);

    for (const member of members) {
      const functies = functiesByKnvb[member.knvb_id] || [];
      try {
        const response = await rondoClubRequestWithRetry(
          'rondo/v1/capability-sync',
          'POST',
          { knvb_id: member.knvb_id, functies }
        );
        if (response.body.status === 'no_user') {
          result.skipped++;
        } else {
          result.synced++;
          if (verbose && (response.body.granted?.length > 0 || response.body.revoked?.length > 0)) {
            log.verbose(`  ${member.knvb_id}: granted=[${response.body.granted?.join(',')}] revoked=[${response.body.revoked?.join(',')}]`);
          }
        }
      } catch (error) {
        result.errors.push({ knvb_id: member.knvb_id, message: error.message });
      }
    }

    result.success = result.errors.length === 0;
  } finally {
    db.close();
  }

  if (!logger) log.close();
  return result;
}

module.exports = { runCapabilitySync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  runCapabilitySync({ verbose })
    .then(result => {
      console.log(`Capability sync complete: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`);
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
