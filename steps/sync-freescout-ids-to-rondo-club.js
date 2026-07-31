require('dotenv/config');

const { openDb: openFreescoutDb, getCustomersNeedingRondoClubSync, updateRondoClubSyncState } = require('../lib/freescout-db');
const { openDb: openRondoClubDb } = require('../lib/rondo-club-db');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { createSyncLogger } = require('../lib/logger');

/**
 * Sync FreeScout IDs back to Rondo Club ACF fields.
 *
 * For each customer in freescout-sync.sqlite that has a freescout_id but hasn't
 * been synced to Rondo Club yet, look up the member's rondo_club_id and write
 * the freescout-id ACF field via PUT.
 */
async function runSyncFreescoutIdsToRondoClub(options = {}) {
  const { logger, verbose = false } = options;
  const log = logger?.log.bind(logger) || console.log;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;

  const result = { synced: 0, skipped: 0, errors: [] };

  let freescoutDb = null;
  let rondoClubDb = null;

  try {
    freescoutDb = openFreescoutDb();
    rondoClubDb = openRondoClubDb();

    const customers = getCustomersNeedingRondoClubSync(freescoutDb);
    log(`FreeScout IDs to sync to Rondo Club: ${customers.length}`);

    if (customers.length === 0) {
      return result;
    }

    // Prepare lookup for rondo_club_id and names
    const memberStmt = rondoClubDb.prepare(`
      SELECT rondo_club_id, data_json FROM rondo_club_members WHERE knvb_id = ?
    `);

    for (const customer of customers) {
      const { knvb_id, freescout_id } = customer;

      const member = memberStmt.get(knvb_id);
      if (!member || !member.rondo_club_id) {
        logVerbose(`Skipping ${knvb_id}: no rondo_club_id`);
        result.skipped++;
        continue;
      }

      const data = JSON.parse(member.data_json || '{}');
      const acf = data.fields || {};
      const firstName = acf.first_name || '';
      const lastName = acf.last_name || '';

      if (!firstName || !lastName) {
        logVerbose(`Skipping ${knvb_id}: missing first_name or last_name`);
        result.skipped++;
        continue;
      }

      try {
        logVerbose(`Syncing freescout_id ${freescout_id} → person ${member.rondo_club_id} (${firstName} ${lastName})`);

        await rondoClubRequest(
          `wp/v2/people/${member.rondo_club_id}`,
          'PUT',
          {
            fields: {
              first_name: firstName,
              last_name: lastName,
              'freescout_id': freescout_id
            }
          },
          { logger, verbose }
        );

        updateRondoClubSyncState(freescoutDb, knvb_id);
        result.synced++;
      } catch (err) {
        logError(`Error syncing ${knvb_id} (person ${member.rondo_club_id}): ${err.message}`);
        result.errors.push({ knvb_id, rondo_club_id: member.rondo_club_id, message: err.message });
      }
    }

    log(`Synced ${result.synced} FreeScout IDs to Rondo Club (${result.skipped} skipped, ${result.errors.length} errors)`);
    return result;
  } finally {
    if (freescoutDb) freescoutDb.close();
    if (rondoClubDb) rondoClubDb.close();
  }
}

module.exports = { runSyncFreescoutIdsToRondoClub };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const logger = createSyncLogger({ verbose, prefix: 'freescout-ids' });

  runSyncFreescoutIdsToRondoClub({ logger, verbose })
    .then(result => {
      logger.log(`Done: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`);
      if (result.errors.length > 0) {
        result.errors.forEach(e => logger.error(`  ${e.knvb_id}: ${e.message}`));
        process.exitCode = 1;
      }
      logger.close();
    })
    .catch(err => {
      logger.error(`Fatal: ${err.message}`);
      logger.close();
      process.exitCode = 1;
    });
}
