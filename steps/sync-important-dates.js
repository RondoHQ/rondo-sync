require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const {
  openDb,
  upsertImportantDate,
  getImportantDatesNeedingSync,
  updateImportantDateSyncState,
  getOrphanImportantDates,
  deleteImportantDate,
  getAllTrackedMembers
} = require('../lib/rondo-club-db');
const { openDb: openLapostaDb, getLatestSportlinkResults } = require('../lib/laposta-db');

/**
 * Load birthdays from Sportlink SQLite database and upsert to tracking table
 * @param {Object} db - Rondo Club database connection
 * @param {Object} options - Logger options
 * @returns {number} Count of members with birthdays
 */
function loadBirthdaysFromSqlite(db, options = {}) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Open Laposta DB to get Sportlink results
  const lapostaDb = openLapostaDb();
  let sportlinkData;
  try {
    const resultsJson = getLatestSportlinkResults(lapostaDb);
    if (!resultsJson) {
      throw new Error('No Sportlink results found in SQLite. Run download first.');
    }
    sportlinkData = JSON.parse(resultsJson);
  } finally {
    lapostaDb.close();
  }

  const members = Array.isArray(sportlinkData.Members) ? sportlinkData.Members : [];
  if (members.length === 0) {
    return 0;
  }

  let birthdayCount = 0;

  for (const member of members) {
    const knvbId = member.PublicPersonId;
    const dateOfBirth = member.DateOfBirth;

    if (knvbId && dateOfBirth && dateOfBirth.match(/^\d{4}-\d{2}-\d{2}$/)) {
      upsertImportantDate(db, knvbId, 'birth_date', dateOfBirth);
      birthdayCount++;
    }
  }

  logVerbose(`Loaded ${birthdayCount} birthdays from SQLite`);
  return birthdayCount;
}

/**
 * Get the term ID for "birthday" date type
 * @param {Object} options - Logger options
 * @returns {Promise<number>} Term ID for birthday
 */
async function getBirthdayTermId(options = {}) {
  const response = await rondoClubRequest(
    'wp/v2/date_type?slug=birthday',
    'GET',
    null,
    options
  );

  if (!response.body || response.body.length === 0) {
    throw new Error('Birthday term not found in date_type taxonomy');
  }

  return response.body[0].id;
}

/**
 * Create a new important date in Rondo Club
 * @param {number} rondoClubPersonId - Rondo Club person post ID
 * @param {string} dateValue - Date in YYYY-MM-DD format
 * @param {number} birthdayTermId - Term ID for birthday date type
 * @param {Object} options - Logger options
 * @returns {Promise<number>} Created important date post ID
 */
async function createImportantDate(rondoClubPersonId, dateValue, birthdayTermId, options = {}) {
  const response = await rondoClubRequest(
    'wp/v2/important-dates',
    'POST',
    {
      status: 'publish',
      title: 'Birthday',
      date_type: [birthdayTermId],
      fields: {
        date_value: dateValue,
        related_people: [rondoClubPersonId],
        year_unknown: false,
        is_recurring: true,
        custom_label: ''
      }
    },
    options
  );

  return response.body.id;
}

/**
 * Update an existing important date in Rondo Club
 * @param {number} rondoClubDateId - Rondo Club important date post ID
 * @param {number} rondoClubPersonId - Rondo Club person post ID
 * @param {string} dateValue - Date in YYYY-MM-DD format
 * @param {Object} options - Logger options
 */
async function updateImportantDate(rondoClubDateId, rondoClubPersonId, dateValue, options = {}) {
  await rondoClubRequest(
    `wp/v2/important-dates/${rondoClubDateId}`,
    'PUT',
    {
      fields: {
        date_value: dateValue,
        related_people: [rondoClubPersonId]
      }
    },
    options
  );
}

/**
 * Delete an important date from Rondo Club
 * @param {number} rondoClubDateId - Rondo Club important date post ID
 * @param {Object} options - Logger options
 */
async function deleteRondoClubImportantDate(rondoClubDateId, options = {}) {
  await rondoClubRequest(
    `wp/v2/important-dates/${rondoClubDateId}`,
    'DELETE',
    null,
    options
  );
}

/**
 * Sync important dates to Rondo Club
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all dates
 * @returns {Promise<Object>} Sync result
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;

  const result = {
    success: true,
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    errors: []
  };

  const db = openDb();
  try {
    // Step 1: Load birthdays from SQLite and upsert to tracking table
    result.total = loadBirthdaysFromSqlite(db, options);

    // Step 2: Get dates needing sync (members must have rondo_club_id)
    const needsSync = getImportantDatesNeedingSync(db, force);
    result.skipped = result.total - needsSync.length;

    logVerbose(`${needsSync.length} important dates need sync (${result.skipped} unchanged or no person)`);

    // Step 2.5: Get the birthday term ID (only if we have dates to create)
    let birthdayTermId = null;
    if (needsSync.some(d => !d.rondo_club_date_id)) {
      logVerbose('Fetching birthday term ID...');
      birthdayTermId = await getBirthdayTermId(options);
      logVerbose(`Birthday term ID: ${birthdayTermId}`);
    }

    // Step 3: Sync each date
    for (let i = 0; i < needsSync.length; i++) {
      const date = needsSync[i];
      logVerbose(`Syncing ${i + 1}/${needsSync.length}: ${date.knvb_id} (${date.date_value})`);

      try {
        if (date.rondo_club_date_id) {
          // Update existing
          await updateImportantDate(date.rondo_club_date_id, date.rondo_club_id, date.date_value, options);
          updateImportantDateSyncState(db, date.knvb_id, date.date_type, date.source_hash, date.rondo_club_date_id);
          result.updated++;
        } else {
          // Create new
          const newId = await createImportantDate(date.rondo_club_id, date.date_value, birthdayTermId, options);
          updateImportantDateSyncState(db, date.knvb_id, date.date_type, date.source_hash, newId);
          result.created++;
        }
        result.synced++;
      } catch (error) {
        console.error(`ERROR for ${date.knvb_id}:`, error.message);
        console.error('Error details:', JSON.stringify(error.details, null, 2));
        result.errors.push({
          knvb_id: date.knvb_id,
          date_value: date.date_value,
          message: error.message,
          details: error.details
        });
      }
    }

    // Step 4: Delete orphan dates (members removed from Sportlink)
    const allMembers = getAllTrackedMembers(db);
    const currentKnvbIds = allMembers.map(m => m.knvb_id);
    const orphanDates = getOrphanImportantDates(db, currentKnvbIds);

    for (const orphan of orphanDates) {
      logVerbose(`Deleting orphan date: ${orphan.knvb_id}`);
      try {
        await deleteRondoClubImportantDate(orphan.rondo_club_date_id, options);
        deleteImportantDate(db, orphan.knvb_id, orphan.date_type);
        result.deleted++;
      } catch (error) {
        result.errors.push({
          knvb_id: orphan.knvb_id,
          message: `Delete failed: ${error.message}`
        });
      }
    }

    result.success = result.errors.length === 0;

  } finally {
    db.close();
  }

  return result;
}

module.exports = { runSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  runSync({ verbose, force })
    .then(result => {
      console.log(`Important dates sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Skipped: ${result.skipped}`);
      console.log(`  Deleted: ${result.deleted}`);

      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => {
          console.error(`    - ${e.knvb_id}: ${e.message}`);
          if (e.details) {
            console.error(`      Details: ${JSON.stringify(e.details, null, 2)}`);
          }
        });
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
