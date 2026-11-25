require('dotenv/config');

const {
  openDb,
  getMembersNeedingSync,
  updateSyncState,
  upsertLapostaFields
} = require('../lib/laposta-db');
const {
  fetchFields,
  upsertMember,
  waitForRateLimit,
  getListConfig
} = require('../lib/laposta-client');
const { parseCliArgs } = require('../lib/utils');
const { createLoggerAdapter } = require('../lib/log-adapters');
const { syncStaleLapostaIdentities } = require('./sync-stale-laposta-identities');

/**
 * Parse CLI arguments for list submission.
 * @param {string[]} argv - Command line arguments
 * @returns {{listIndex: number|null, force: boolean, verbose: boolean}}
 */
function parseArgs(argv) {
  const { verbose, force } = parseCliArgs(argv);
  const args = argv.slice(2).filter(arg => !arg.startsWith('--'));
  const listIndex = args[0] ? Number.parseInt(args[0], 10) : null;
  return { listIndex, force, verbose };
}

/**
 * Determine if a member upsert was an add or update.
 * Compares created and modified timestamps from Laposta response.
 * @param {Object} memberData - Member data from Laposta response
 * @returns {'added'|'updated'}
 */
function classifyUpsertResult(memberData) {
  if (!memberData) return 'updated';
  return memberData.created === memberData.modified ? 'added' : 'updated';
}

/**
 * Sync a single list to Laposta.
 * @param {number} listIndex - List index (1-4)
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose] - Verbose mode
 * @param {boolean} [options.force] - Force sync all members
 * @returns {Promise<{index: number, listId: string|null, total: number, synced: number, added: number, updated: number, errors: Array}>}
 */
async function syncList(listIndex, options = {}) {
  const { logger, verbose = false, force = false } = options;
  const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

  const { listId } = getListConfig(listIndex);

  const emptyResult = {
    index: listIndex,
    listId: null,
    total: 0,
    synced: 0,
    added: 0,
    updated: 0,
    errors: []
  };

  if (!listId) {
    return emptyResult;
  }

  const db = openDb();
  const result = { ...emptyResult, listId };

  try {
    // Fetch and cache Laposta fields (non-fatal if fails)
    try {
      const fields = await fetchFields(listId);
      if (fields.length > 0) {
        upsertLapostaFields(db, listId, fields);
      }
    } catch (error) {
      logVerbose(`Warning: could not fetch Laposta fields: ${error.message}`);
    }

    const members = getMembersNeedingSync(db, listIndex, force);
    result.total = members.length;

    if (members.length === 0) {
      return result;
    }

    for (let i = 0; i < members.length; i += 1) {
      const member = members[i];
      logVerbose(`Syncing ${i + 1}/${members.length}: ${member.email}`);

      try {
        const response = await upsertMember(listId, member);
        updateSyncState(db, listIndex, member.email, member.source_hash, member.custom_fields);
        result.synced += 1;

        const classification = classifyUpsertResult(response.body?.member);
        if (classification === 'added') {
          result.added += 1;
        } else {
          result.updated += 1;
        }
      } catch (error) {
        const errorMessage = error.details?.error?.message || error.message || String(error);
        result.errors.push({ email: member.email, message: errorMessage });
      }

      // Rate limit between requests (skip after last)
      if (i < members.length - 1) {
        await waitForRateLimit();
      }
    }

    return result;
  } finally {
    db.close();
  }
}

/**
 * Run Laposta submission.
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode (show per-member progress)
 * @param {boolean} [options.force=false] - Sync all members, not just changed
 * @param {number|null} [options.listIndex=null] - Specific list (1-4) or null for all
 * @returns {Promise<{success: boolean, lists: Array, error?: string}>}
 */
async function runSubmit(options = {}) {
  const { logger, verbose = false, force = false, listIndex = null, dependencies = {} } = options;
  const logError = logger ? logger.error.bind(logger) : console.error;

  try {
    const isValidListIndex = listIndex && listIndex >= 1 && listIndex <= 4;
    const listIndexes = isValidListIndex ? [listIndex] : [1, 2, 3, 4];

    const lists = [];
    for (const index of listIndexes) {
      const result = await (dependencies.syncList || syncList)(index, { logger, verbose, force });
      lists.push(result);
    }

    // Only reconcile after every configured list has been submitted successfully.
    // A single-list run cannot establish that all replacement identities are ready.
    if (!listIndex && lists.every(list => list.errors.length === 0)) {
      const cleanup = await (dependencies.syncStaleLapostaIdentities || syncStaleLapostaIdentities)({ apply: true, deferStaleSource: true, logger });
      lists[0].errors.push(...cleanup.errors);
    }
    const totalErrors = lists.reduce((sum, list) => sum + list.errors.length, 0);

    return {
      success: totalErrors === 0,
      lists
    };
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error:', errorMsg);
    return {
      success: false,
      lists: [],
      error: errorMsg
    };
  }
}

/**
 * Print sync result summary to console.
 * @param {Object} result - Result from runSubmit
 * @param {boolean} force - Whether force mode was used
 */
function printSummary(result, force) {
  const label = force ? 'members' : 'changed members';

  result.lists.forEach(list => {
    if (!list.listId) {
      console.log(`Skipping list ${list.index}: not configured in .env`);
      return;
    }

    if (list.total === 0) {
      console.log(`No changes to sync for list ${list.index}.`);
      return;
    }

    console.log(`List ${list.index}: ${list.synced}/${list.total} ${label} synced (${list.added} added, ${list.updated} updated)`);

    if (list.errors.length > 0) {
      console.error(`  ${list.errors.length} errors occurred`);
    }
  });
}

module.exports = { runSubmit };

// CLI entry point
if (require.main === module) {
  const { listIndex, force, verbose } = parseArgs(process.argv);

  runSubmit({ verbose, force, listIndex })
    .then(result => {
      printSummary(result, force);
      if (!result.success) {
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      if (err.details) {
        console.error('Details:', JSON.stringify(err.details, null, 2));
      }
      process.exitCode = 1;
    });
}
