require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const {
  openDb,
  getCommissiesNeedingSync,
  updateCommissieSyncState,
  getOrphanCommissies,
  deleteCommissie,
  getAllCommissies,
  upsertCommissies
} = require('../lib/rondo-club-db');

/**
 * Fetch the set of Rondo-managed commissie IDs (pool commissies seeded inside
 * Rondo). These must NEVER be deleted by the untracked-commissie cleanup —
 * they have no Sportlink source and are managed entirely in Rondo.
 *
 * Returns a Set of integer commissie IDs. Returns an empty Set if the endpoint
 * is unreachable, which is the conservative choice (sync may still run but the
 * deletion safety net catches mass-delete bugs separately).
 *
 * @param {Object} options - Logger and request options.
 * @returns {Promise<Set<number>>}
 */
async function fetchRondoManagedCommissieIds(options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  try {
    const response = await rondoClubRequest('rondo/v1/managed-commissies', 'GET', null, options);
    const ids = Array.isArray(response.body?.ids) ? response.body.ids : [];
    logVerbose(`  ${ids.length} Rondo-managed commissies will be protected from cleanup`);
    return new Set(ids.map(n => parseInt(n, 10)).filter(n => !isNaN(n)));
  } catch (error) {
    // Endpoint may not exist on older versions of Rondo Club — that's fine,
    // just protect nothing and continue. Log so it shows up in sync reports.
    logVerbose(`  Could not fetch Rondo-managed commissies: ${error.message} — protecting none`);
    return new Set();
  }
}

/**
 * Fetch all commissies from WordPress API (paginated)
 * @param {Object} options - Logger options
 * @returns {Promise<Array<{id: number, title: string}>>}
 */
async function fetchAllWordPressCommissies(options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});
  const commissies = [];
  let page = 1;

  while (true) {
    const response = await rondoClubRequest(`wp/v2/commissies?per_page=100&page=${page}`, 'GET', null, options);
    const pageCommissies = Array.isArray(response.body) ? response.body : [];
    commissies.push(...pageCommissies.map(c => ({ id: c.id, title: c.title?.rendered || c.title })));
    logVerbose(`  Fetched page ${page}: ${pageCommissies.length} commissies`);

    const totalPages = Number.parseInt(
      response.headers?.['x-wp-totalpages'] || response.headers?.['X-WP-TotalPages'] || '0',
      10
    );
    if (pageCommissies.length < 100 || (totalPages > 0 && page >= totalPages)) break;
    page++;
  }

  return commissies;
}

/**
 * Sync a single commissie to Rondo Club (create or update)
 * @param {Object} commissie - Commissie record from database
 * @param {Object} db - SQLite database connection
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<{action: string, id: number}>}
 */
async function syncCommissie(commissie, db, options) {
  const { commissie_name, source_hash, last_synced_hash } = commissie;
  let { rondo_club_id } = commissie;
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  if (rondo_club_id) {
    // Commissie exists - check if changed (unless force)
    if (!options.force && source_hash === last_synced_hash) {
      logVerbose(`Commissie unchanged, skipping: ${commissie_name}`);
      return { action: 'skipped', id: rondo_club_id };
    }
    // UPDATE existing commissie
    const payload = {
      title: commissie_name,
      status: 'publish'
    };
    const endpoint = `wp/v2/commissies/${rondo_club_id}`;
    logVerbose(`Updating existing commissie: ${rondo_club_id} - ${commissie_name}`);
    logVerbose(`  PUT ${endpoint}`);
    try {
      const response = await rondoClubRequest(endpoint, 'PUT', payload, options);
      updateCommissieSyncState(db, commissie_name, source_hash, rondo_club_id);
      return { action: 'updated', id: rondo_club_id };
    } catch (error) {
      // Check if commissie was deleted in WordPress (404)
      if (error.details?.code === 'rest_post_invalid_id' || error.details?.data?.status === 404) {
        logVerbose(`Commissie ${commissie_name} (ID: ${rondo_club_id}) no longer exists in WordPress, recreating...`);
        rondo_club_id = null;
        updateCommissieSyncState(db, commissie_name, null, null);
      } else {
        console.error(`API Error updating commissie "${commissie_name}" (ID: ${rondo_club_id}):`);
        console.error(`  Status: ${error.message}`);
        if (error.details) {
          console.error(`  Code: ${error.details.code || 'unknown'}`);
          console.error(`  Message: ${error.details.message || JSON.stringify(error.details)}`);
        }
        throw error;
      }
    }
  }

  // CREATE new commissie (or recreate if deleted from WordPress)
  if (!rondo_club_id) {
    const payload = {
      title: commissie_name,
      status: 'publish',
      content: ''
    };
    const endpoint = 'wp/v2/commissies';
    logVerbose(`Creating new commissie: ${commissie_name}`);
    logVerbose(`  POST ${endpoint}`);
    try {
      const response = await rondoClubRequest(endpoint, 'POST', payload, options);
      const newId = response.body.id;
      updateCommissieSyncState(db, commissie_name, source_hash, newId);
      return { action: 'created', id: newId };
    } catch (error) {
      console.error(`API Error creating commissie "${commissie_name}":`);
      console.error(`  Status: ${error.message}`);
      if (error.details) {
        console.error(`  Code: ${error.details.code || 'unknown'}`);
        console.error(`  Message: ${error.details.message || JSON.stringify(error.details)}`);
      }
      throw error;
    }
  }
}

/**
 * Main sync orchestration for commissies
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all commissies
 * @param {boolean} [options.enableOrphanDetection=false] - Enable orphan commissie detection and deletion
 * @returns {Promise<Object>} - Sync result
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false, enableOrphanDetection = false, onProgress = null } = options;
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
      // Ensure "Verenigingsbreed" commissie exists (for club-level functions)
      const existingCommissies = getAllCommissies(db);
      const hasVerenigingsbreed = existingCommissies.some(c => c.commissie_name === 'Verenigingsbreed');

      if (!hasVerenigingsbreed) {
        logVerbose('Creating "Verenigingsbreed" commissie for club-level functions');
        upsertCommissies(db, [{ commissie_name: 'Verenigingsbreed', sportlink_id: null }]);
      }

      // Get all commissies needing sync
      const needsSync = getCommissiesNeedingSync(db, force);
      result.total = needsSync.length;

      if (needsSync.length === 0) {
        logVerbose('No commissies need syncing');
      } else {
        logVerbose(`${needsSync.length} commissies need sync`);

        // Sync each commissie
        for (let i = 0; i < needsSync.length; i++) {
          const commissie = needsSync[i];
          logVerbose(`Syncing ${i + 1}/${needsSync.length}: ${commissie.commissie_name}`);
          if (onProgress) {
            onProgress({ current: i + 1, total: needsSync.length, label: commissie.commissie_name });
          }

          try {
            const syncResult = await syncCommissie(commissie, db, options);
            if (syncResult.action !== 'skipped') {
              result.synced++;
            }
            if (syncResult.action === 'created') result.created++;
            if (syncResult.action === 'updated') result.updated++;
            if (syncResult.action === 'skipped') result.skipped++;
          } catch (error) {
            result.errors.push({
              commissie_name: commissie.commissie_name,
              message: error.message
            });
            logError(`Error syncing commissie ${commissie.commissie_name}: ${error.message}`);
          }
        }
      }

      // Handle orphan commissies (if enabled)
      if (enableOrphanDetection) {
        // Get FRESH commissie names from Sportlink data (after tracking table has been updated)
        const allCommissies = getAllCommissies(db);
        const currentCommissieNames = allCommissies.map(c => c.commissie_name);

        const orphanCommissies = getOrphanCommissies(db, currentCommissieNames);
        if (orphanCommissies.length > 0) {
          logVerbose(`Found ${orphanCommissies.length} orphan commissies to delete`);

          for (const orphan of orphanCommissies) {
            logVerbose(`Deleting orphan commissie: ${orphan.commissie_name} (ID: ${orphan.rondo_club_id})`);

            // Delete from WordPress if it has a rondo_club_id
            if (orphan.rondo_club_id) {
              try {
                await rondoClubRequest(`wp/v2/commissies/${orphan.rondo_club_id}`, 'DELETE', { force: true }, options);
                logVerbose(`  Deleted from WordPress: ${orphan.rondo_club_id}`);
              } catch (error) {
                // Ignore 404 errors (already deleted)
                if (error.details?.data?.status !== 404) {
                  logError(`  Error deleting from WordPress: ${error.message}`);
                  result.errors.push({
                    commissie_name: orphan.commissie_name,
                    message: `Delete failed: ${error.message}`
                  });
                  continue;
                }
                logVerbose(`  Already deleted from WordPress (404)`);
              }
            }

            // Delete from tracking database
            deleteCommissie(db, orphan.commissie_name);
            result.deleted++;
          }
        }
      }

      // Delete untracked WordPress commissies
      logVerbose('Checking for untracked commissies in WordPress...');
      const wordPressCommissies = await fetchAllWordPressCommissies(options);
      const trackedCommissies = getAllCommissies(db);
      const trackedRondoClubIds = new Set(trackedCommissies.filter(c => c.rondo_club_id).map(c => c.rondo_club_id));

      // Rondo-managed commissies (pool commissies for the volunteer-policy work)
      // live entirely in WordPress and have no Sportlink source. Treat them as
      // off-limits for the untracked cleanup.
      const rondoManagedIds = await fetchRondoManagedCommissieIds(options);

      const untrackedCommissies = wordPressCommissies.filter(
        c => !trackedRondoClubIds.has(c.id) && !rondoManagedIds.has(c.id)
      );

      // Safety: if ALL WordPress commissies are "untracked", the tracking DB is likely
      // empty or corrupt — deleting everything would be destructive, so skip.
      if (untrackedCommissies.length > 0 && untrackedCommissies.length < wordPressCommissies.length) {
        logVerbose(`Found ${untrackedCommissies.length} untracked commissies in WordPress to delete`);

        for (const commissie of untrackedCommissies) {
          logVerbose(`Deleting untracked commissie: ${commissie.title} (ID: ${commissie.id})`);
          try {
            await rondoClubRequest(`wp/v2/commissies/${commissie.id}`, 'DELETE', { force: true }, options);
            logVerbose(`  Deleted from WordPress: ${commissie.id}`);
            result.deleted++;
          } catch (error) {
            if (error.details?.data?.status !== 404) {
              logError(`  Error deleting untracked commissie: ${error.message}`);
              result.errors.push({
                commissie_name: commissie.title,
                message: `Delete untracked failed: ${error.message}`
              });
            } else {
              logVerbose(`  Already deleted from WordPress (404)`);
            }
          }
        }
      } else if (untrackedCommissies.length === wordPressCommissies.length && wordPressCommissies.length > 0) {
        logVerbose(`Safety: ALL ${wordPressCommissies.length} WordPress commissies are untracked — skipping deletion (likely tracking DB issue)`);
      } else {
        logVerbose('No untracked commissies found in WordPress');
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

module.exports = { fetchAllWordPressCommissies, runSync };

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
      console.log(`Rondo Club commissies sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Skipped: ${result.skipped}`);
      if (result.deleted > 0) {
        console.log(`  Deleted: ${result.deleted} (orphan commissies)`);
      }
      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.error(`    - ${e.commissie_name}: ${e.message}`));
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
