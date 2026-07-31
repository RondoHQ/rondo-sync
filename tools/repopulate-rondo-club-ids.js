require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb, updateSyncState, getAllTrackedMembers } = require('../lib/rondo-club-db');

/**
 * Fetch all people from Rondo Club with their KNVB IDs.
 * Uses pagination to handle large datasets.
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<Map<string, number>>} - Map<knvb_id, rondo_club_id>
 */
async function fetchAllPeopleFromRondoClub(options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  const knvbToRondoClub = new Map();
  let page = 1;
  let hasMore = true;

  logVerbose('Fetching all people from Rondo Club...');

  while (hasMore) {
    let response;
    try {
      response = await rondoClubRequest(
        `wp/v2/people?_fields=id,fields.knvb_id&per_page=100&page=${page}`,
        'GET',
        null,
        options
      );
    } catch (error) {
      // End of pagination (400 error is expected when page exceeds total)
      if (error.message.includes('400')) {
        hasMore = false;
        break;
      }
      throw error;
    }

    // Handle end of pagination (empty array)
    if (!Array.isArray(response.body) || response.body.length === 0) {
      hasMore = false;
      break;
    }

    const people = response.body;

    for (const person of people) {
      const knvbId = person.fields?.['knvb_id'];
      if (knvbId) {
        knvbToRondoClub.set(knvbId, person.id);
      }
    }

    logVerbose(`  Page ${page}: ${people.length} people (${knvbToRondoClub.size} with KNVB IDs)`);
    page++;

    // Safety: stop if we've fetched too many pages
    if (page > 50) {
      console.error('Warning: Hit page limit, stopping');
      break;
    }
  }

  return knvbToRondoClub;
}

/**
 * Repopulate rondo_club_ids in local database from Rondo Club API.
 * @param {Object} options
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.dryRun=false] - Don't update, just report
 */
async function runRepopulate(options = {}) {
  const { verbose = false, dryRun = false } = options;
  const logVerbose = verbose ? console.log : () => {};

  const db = openDb();

  try {
    // Fetch all people from Rondo Club
    const knvbToRondoClub = await fetchAllPeopleFromRondoClub(options);
    console.log(`Found ${knvbToRondoClub.size} people in Rondo Club with KNVB IDs`);

    // Get all tracked members from local DB (including those without rondo_club_id)
    const trackedMembers = db.prepare(`
      SELECT knvb_id, rondo_club_id, last_synced_hash
      FROM rondo_club_members
      WHERE knvb_id IS NOT NULL
    `).all();
    console.log(`Found ${trackedMembers.length} members in local database`);

    let updated = 0;
    let alreadySet = 0;
    let notInRondoClub = 0;

    for (const member of trackedMembers) {
      const rondoClubId = knvbToRondoClub.get(member.knvb_id);

      if (rondoClubId) {
        if (member.rondo_club_id === rondoClubId) {
          alreadySet++;
          continue;
        }

        if (dryRun) {
          logVerbose(`Would update ${member.knvb_id}: rondo_club_id ${member.rondo_club_id || 'null'} -> ${rondoClubId}`);
        } else {
          // Update the rondo_club_id - use existing hash to avoid re-syncing
          updateSyncState(db, member.knvb_id, member.last_synced_hash, rondoClubId);
          logVerbose(`Updated ${member.knvb_id}: rondo_club_id -> ${rondoClubId}`);
        }
        updated++;
      } else {
        logVerbose(`${member.knvb_id} not found in Rondo Club`);
        notInRondoClub++;
      }
    }

    console.log(`\nResults:`);
    console.log(`  Updated: ${updated}${dryRun ? ' (dry run)' : ''}`);
    console.log(`  Already set: ${alreadySet}`);
    console.log(`  Not in Rondo Club: ${notInRondoClub}`);

    return { updated, alreadySet, notInRondoClub };
  } finally {
    db.close();
  }
}

module.exports = { runRepopulate };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const dryRun = process.argv.includes('--dry-run');

  runRepopulate({ verbose, dryRun })
    .then(result => {
      process.exitCode = 0;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
