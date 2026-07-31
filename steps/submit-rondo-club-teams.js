require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const {
  openDb,
  getTeamsNeedingSync,
  updateTeamSyncState,
  getOrphanTeamsBySportlinkId,
  deleteTeam,
  getAllTeamsForSync
} = require('../lib/rondo-club-db');

/**
 * Fetch all teams from WordPress API (paginated)
 * @param {Object} options - Logger options
 * @returns {Promise<Array<{id: number, title: string}>>}
 */
async function fetchAllWordPressTeams(options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  const teams = [];
  let page = 1;

  while (true) {
    try {
      const response = await rondoClubRequest(`wp/v2/teams?per_page=100&page=${page}`, 'GET', null, options);
      const pageTeams = response.body;
      if (pageTeams.length === 0) break;
      teams.push(...pageTeams.map(t => ({ id: t.id, title: t.title?.rendered || t.title })));
      logVerbose(`  Fetched page ${page}: ${pageTeams.length} teams`);
      page++;
    } catch (error) {
      // End of pages (400 error) or other error
      if (error.details?.code === 'rest_post_invalid_page_number') {
        break;
      }
      throw error;
    }
  }

  return teams;
}

/**
 * Sync a single team to Rondo Club (create or update)
 * Uses local rondo_club_id tracking - no API search needed
 * @param {Object} team - Team record from database
 * @param {Object} db - SQLite database connection
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{action: string, id: number}>}
 */
async function syncTeam(team, db, options) {
  const { team_name, sportlink_id, game_activity, gender, source_hash, last_synced_hash } = team;
  let { rondo_club_id } = team;
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Build canonical fields payload
  const fields = {};
  if (sportlink_id) fields.publicteamid = sportlink_id;
  if (game_activity) fields.activiteit = game_activity;

  // Map Sportlink gender values to Rondo Club API values
  const genderMap = {
    'Mannen': 'male',
    'Vrouwen': 'female'
    // 'Gemengd' is not mapped - skip it as Rondo Club doesn't have a mixed option
  };
  if (gender && genderMap[gender]) fields.gender = genderMap[gender];

  if (rondo_club_id) {
    // Team exists - check if changed (unless force)
    if (!options.force && source_hash === last_synced_hash) {
      logVerbose(`Team unchanged, skipping: ${team_name}`);
      return { action: 'skipped', id: rondo_club_id };
    }
    // UPDATE existing team (unlikely - team names don't change often)
    const payload = {
      title: team_name,
      status: 'publish',
      fields: fields
    };
    const endpoint = `wp/v2/teams/${rondo_club_id}`;
    logVerbose(`Updating existing team: ${rondo_club_id} - ${team_name}`);
    logVerbose(`  PUT ${endpoint}`);
    logVerbose(`  Payload: ${JSON.stringify(payload)}`);
    try {
      const response = await rondoClubRequest(endpoint, 'PUT', payload, options);
      updateTeamSyncState(db, sportlink_id, source_hash, rondo_club_id);
      return { action: 'updated', id: rondo_club_id };
    } catch (error) {
      // Check if team was deleted in WordPress (404 with rest_post_invalid_id)
      if (error.details?.code === 'rest_post_invalid_id' || error.details?.data?.status === 404) {
        logVerbose(`Team ${team_name} (ID: ${rondo_club_id}) no longer exists in WordPress, recreating...`);
        // Clear the rondo_club_id so we fall through to create
        rondo_club_id = null;
        updateTeamSyncState(db, sportlink_id, null, null);
      } else {
        console.error(`API Error updating team "${team_name}" (ID: ${rondo_club_id}):`);
        console.error(`  Status: ${error.message}`);
        if (error.details) {
          console.error(`  Code: ${error.details.code || 'unknown'}`);
          console.error(`  Message: ${error.details.message || JSON.stringify(error.details)}`);
          if (error.details.data) {
            console.error(`  Data: ${JSON.stringify(error.details.data)}`);
          }
        }
        throw error;
      }
    }
  }

  // CREATE new team (or recreate if deleted from WordPress)
  if (!rondo_club_id) {
    const payload = {
      title: team_name,
      status: 'publish',
      fields: fields
    };
    const endpoint = 'wp/v2/teams';
    logVerbose(`Creating new team: ${team_name}`);
    logVerbose(`  POST ${endpoint}`);
    logVerbose(`  Payload: ${JSON.stringify(payload)}`);
    try {
      const response = await rondoClubRequest(endpoint, 'POST', payload, options);
      const newId = response.body.id;
      updateTeamSyncState(db, sportlink_id, source_hash, newId);
      return { action: 'created', id: newId };
    } catch (error) {
      console.error(`API Error creating team "${team_name}":`);
      console.error(`  Status: ${error.message}`);
      if (error.details) {
        console.error(`  Code: ${error.details.code || 'unknown'}`);
        console.error(`  Message: ${error.details.message || JSON.stringify(error.details)}`);
        if (error.details.data) {
          console.error(`  Data: ${JSON.stringify(error.details.data)}`);
        }
      }
      throw error;
    }
  }
}

/**
 * Main sync orchestration for teams
 *
 * NOTE: This function reads team data that was already populated by download-teams-from-sportlink.js.
 * Team download provides sportlink_id which is required for proper team rename handling.
 *
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all teams
 * @param {Array<string>} [options.currentSportlinkIds] - Current Sportlink team IDs for orphan detection
 * @returns {Promise<Object>} - Sync result
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false, currentSportlinkIds = null } = options;
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

  try {
    const db = openDb();
    try {
      // Get all teams from database (populated by download-teams-from-sportlink.js)
      const allTeams = getAllTeamsForSync(db);
      result.total = allTeams.length;

      if (allTeams.length === 0) {
        logVerbose('No teams in database. Run team download first.');
        return result;
      }

      logVerbose(`Found ${allTeams.length} teams in database`);

      // Get teams needing sync (hash changed or force)
      const needsSync = getTeamsNeedingSync(db, force);

      logVerbose(`${needsSync.length} teams need sync`);

      // Sync each team
      for (let i = 0; i < needsSync.length; i++) {
        const team = needsSync[i];
        logVerbose(`Syncing ${i + 1}/${needsSync.length}: ${team.team_name}`);

        try {
          const syncResult = await syncTeam(team, db, options);
          if (syncResult.action !== 'skipped') {
            result.synced++;
          }
          if (syncResult.action === 'created') result.created++;
          if (syncResult.action === 'updated') result.updated++;
          if (syncResult.action === 'skipped') result.skipped++;
        } catch (error) {
          result.errors.push({
            team_name: team.team_name,
            message: error.message
          });
          logError(`Error syncing team ${team.team_name}: ${error.message}`);
        }
      }

      // Delete orphan teams (in database but not in current Sportlink data)
      // Use sportlink_id for comparison to handle renames correctly
      const sportlinkIds = currentSportlinkIds || allTeams.filter(t => t.sportlink_id).map(t => t.sportlink_id);
      const orphanTeams = getOrphanTeamsBySportlinkId(db, sportlinkIds);
      if (orphanTeams.length > 0) {
        logVerbose(`Found ${orphanTeams.length} orphan teams to delete`);

        for (const orphan of orphanTeams) {
          logVerbose(`Deleting orphan team: ${orphan.team_name} (ID: ${orphan.rondo_club_id})`);

          // Delete from WordPress if it has a rondo_club_id
          if (orphan.rondo_club_id) {
            try {
              await rondoClubRequest(`wp/v2/teams/${orphan.rondo_club_id}`, 'DELETE', { force: true }, options);
              logVerbose(`  Deleted from WordPress: ${orphan.rondo_club_id}`);
            } catch (error) {
              // Ignore 404 errors (already deleted)
              if (error.details?.data?.status !== 404) {
                logError(`  Error deleting from WordPress: ${error.message}`);
                result.errors.push({
                  team_name: orphan.team_name,
                  message: `Delete failed: ${error.message}`
                });
                continue;
              }
              logVerbose(`  Already deleted from WordPress (404)`);
            }
          }

          // Delete from tracking database
          deleteTeam(db, orphan.team_name);
          result.deleted++;
        }
      }

      // Delete untracked WordPress teams (teams in WordPress but never tracked locally)
      // This catches teams created before tracking was implemented
      logVerbose('Checking for untracked teams in WordPress...');
      const wordPressTeams = await fetchAllWordPressTeams(options);
      // Re-fetch teams to get updated rondo_club_ids from newly created teams
      const updatedTeams = getAllTeamsForSync(db);
      const trackedRondoClubIds = new Set(updatedTeams.filter(t => t.rondo_club_id).map(t => t.rondo_club_id));

      const untrackedTeams = wordPressTeams.filter(t => !trackedRondoClubIds.has(t.id));
      if (untrackedTeams.length > 0) {
        logVerbose(`Found ${untrackedTeams.length} untracked teams in WordPress to delete`);

        for (const team of untrackedTeams) {
          logVerbose(`Deleting untracked team: ${team.title} (ID: ${team.id})`);
          try {
            await rondoClubRequest(`wp/v2/teams/${team.id}`, 'DELETE', { force: true }, options);
            logVerbose(`  Deleted from WordPress: ${team.id}`);
            result.deleted++;
          } catch (error) {
            if (error.details?.data?.status !== 404) {
              logError(`  Error deleting untracked team: ${error.message}`);
              result.errors.push({
                team_name: team.title,
                message: `Delete untracked failed: ${error.message}`
              });
            } else {
              logVerbose(`  Already deleted from WordPress (404)`);
            }
          }
        }
      } else {
        logVerbose('No untracked teams found in WordPress');
      }

    } finally {
      db.close();
    }

    result.success = result.errors.length === 0;
    return result;

  } catch (error) {
    result.success = false;
    result.error = error.message;
    logError(`Sync error: ${error.message}`);
    return result;
  }
}

module.exports = { runSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  const options = {
    verbose,
    force
  };

  runSync(options)
    .then(result => {
      console.log(`Rondo Club teams sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Skipped: ${result.skipped}`);
      if (result.deleted > 0) {
        console.log(`  Deleted: ${result.deleted} (orphan teams)`);
      }
      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.error(`    - ${e.team_name}: ${e.message}`));
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
