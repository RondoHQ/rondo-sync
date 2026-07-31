require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const {
  openDb,
  getAllCommissies,
  getAllActiveMemberFunctions,
  getAllActiveMemberCommittees,
  getMemberCommittees,
  getMemberFunctions,
  upsertCommissieWorkHistory,
  getCommissieWorkHistoryNeedingSync,
  getMemberCommissieWorkHistory,
  updateCommissieWorkHistorySyncState,
  deleteCommissieWorkHistory,
  computeCommissieWorkHistoryHash
} = require('../lib/rondo-club-db');

/**
 * Convert JS Date to ACF date format (YYYYMMDD).
 * @param {Date} date - Date object
 * @returns {string} - ACF date string
 */
function formatDateForACF(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Convert Sportlink date format to ACF date format
 * Sportlink format: "2023-01-01" or similar
 * ACF work_history format: "Y-m-d" (e.g., "2023-01-01")
 * @param {string} dateStr - Sportlink date string
 * @returns {string} - ACF date string or empty
 */
function convertDateForACF(dateStr) {
  if (!dateStr) return '';
  // Remove any time component, keep Y-m-d format
  return dateStr.split('T')[0];
}

/**
 * Build ACF work_history entry for a commissie.
 * @param {number} commissieRondoClubId - Commissie WordPress post ID
 * @param {string} jobTitle - Job title/role
 * @param {boolean} isActive - Is current
 * @param {string} startDate - Start date (Sportlink format)
 * @param {string} endDate - End date (Sportlink format)
 * @returns {Object} - ACF work_history entry
 */
function buildWorkHistoryEntry(commissieRondoClubId, jobTitle, isActive, startDate, endDate) {
  if (!jobTitle) {
    return null;  // Caller handles skip
  }
  return {
    job_title: jobTitle,
    is_current: isActive,
    start_date: convertDateForACF(startDate),
    end_date: isActive ? '' : convertDateForACF(endDate),
    team: commissieRondoClubId  // Note: This will work once Rondo Club's work_history.team field accepts commissie post type
  };
}

/**
 * Detect commissie changes for a member.
 * Compares current commissies vs SYNCED records in SQLite.
 * Only records that have been actually synced to WordPress (have rondo_club_work_history_id)
 * are considered "tracked". Unsynced records in the tracking table are treated as new.
 * @param {Object} db - SQLite database connection
 * @param {string} knvbId - Member KNVB ID
 * @param {Array<{commissie_name: string, role_name: string, is_active: boolean}>} currentCommissies - Current commissie memberships
 * @returns {Object} - { added: [], removed: [], unchanged: [] }
 */
function detectCommissieChanges(db, knvbId, currentCommissies) {
  const trackedHistory = getMemberCommissieWorkHistory(db, knvbId);
  // Only consider records as "synced" if they have a rondo_club_work_history_id
  // Records just inserted by upsertCommissieWorkHistory won't have this set
  const syncedHistory = trackedHistory.filter(h => h.rondo_club_work_history_id !== null);

  // Create composite keys for matching (commissie_name + role_name)
  const makeKey = (commissieName, roleName) => `${commissieName}|${roleName || ''}`;
  const syncedKeys = new Set(syncedHistory.map(h => makeKey(h.commissie_name, h.role_name)));
  const currentKeys = new Set(currentCommissies.map(c => makeKey(c.commissie_name, c.role_name)));

  const added = currentCommissies.filter(c => !syncedKeys.has(makeKey(c.commissie_name, c.role_name)));
  const removed = syncedHistory.filter(h => !currentKeys.has(makeKey(h.commissie_name, h.role_name)));
  const unchanged = currentCommissies.filter(c => syncedKeys.has(makeKey(c.commissie_name, c.role_name)));

  return { added, removed, unchanged };
}

/**
 * Sync commissie work history for a single member.
 * @param {Object} member - Member with KNVB ID, rondo_club_id
 * @param {Array} currentCommissies - Current commissie memberships
 * @param {Object} db - Rondo Club SQLite database
 * @param {Map} commissieMap - Map<commissie_name, rondo_club_id>
 * @param {Object} options - Logger and verbose options
 * @param {boolean} force - Force update even unchanged entries
 * @returns {Promise<{action: string, added: number, ended: number}>}
 */
async function syncCommissieWorkHistoryForMember(member, currentCommissies, db, commissieMap, options, force = false) {
  const { knvb_id, rondo_club_id } = member;
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Skip if member not yet synced to Rondo Club
  if (!rondo_club_id) {
    logVerbose(`Skipping ${knvb_id}: not yet synced to Rondo Club`);
    return { action: 'skipped', added: 0, ended: 0 };
  }

  // Detect changes
  const changes = detectCommissieChanges(db, knvb_id, currentCommissies);
  logVerbose(`Member ${knvb_id}: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.unchanged.length} unchanged`);

  // Fetch existing data from WordPress
  let existingWorkHistory = [];
  let existingFirstName = '';
  let existingLastName = '';
  try {
    const response = await rondoClubRequest(`wp/v2/people/${rondo_club_id}`, 'GET', null, options);
    existingWorkHistory = response.body.acf?.work_history || [];
    existingFirstName = response.body.acf?.first_name || '';
    existingLastName = response.body.acf?.last_name || '';
  } catch (error) {
    logVerbose(`Could not fetch existing data for ${knvb_id}: ${error.message}`);
  }

  let addedCount = 0;
  let endedCount = 0;
  let modified = false;

  // Build new work_history array
  const newWorkHistory = [...existingWorkHistory];

  // Handle removed commissies (only sync-created entries)
  for (const removed of changes.removed) {
    if (removed.rondo_club_work_history_id !== null && removed.rondo_club_work_history_id !== undefined) {
      // This is a sync-created entry, we can modify it
      const index = removed.rondo_club_work_history_id;
      if (index < newWorkHistory.length) {
        newWorkHistory[index] = {
          ...newWorkHistory[index],
          is_current: false,
          end_date: formatDateForACF(new Date())
        };
        endedCount++;
        modified = true;
      }
      // Delete from tracking
      deleteCommissieWorkHistory(db, knvb_id, removed.commissie_name, removed.role_name);
      logVerbose(`Ended work_history for commissie ${removed.commissie_name} (index ${index})`);
    } else {
      // Manual entry, don't modify but remove from tracking
      deleteCommissieWorkHistory(db, knvb_id, removed.commissie_name, removed.role_name);
      logVerbose(`Removed tracking for manual entry: ${removed.commissie_name}`);
    }
  }

  // Handle added commissies
  for (const commissie of changes.added) {
    const commissieRondoClubId = commissieMap.get(commissie.commissie_name);
    if (!commissieRondoClubId) {
      logVerbose(`Warning: Commissie "${commissie.commissie_name}" not found in Rondo Club, skipping`);
      continue;
    }

    if (!commissie.role_name) {
      logVerbose(`Warning: Commissie "${commissie.commissie_name}" has no role_name for ${knvb_id}, skipping`);
      continue;
    }

    const entry = buildWorkHistoryEntry(
      commissieRondoClubId,
      commissie.role_name,
      commissie.is_active !== false,
      commissie.relation_start,
      commissie.relation_end
    );
    const newIndex = newWorkHistory.length;
    newWorkHistory.push(entry);

    // Update tracking with rondo_club_work_history_id
    const sourceHash = computeCommissieWorkHistoryHash(
      knvb_id,
      commissie.commissie_name,
      commissie.role_name,
      commissie.is_active
    );
    updateCommissieWorkHistorySyncState(db, knvb_id, commissie.commissie_name, commissie.role_name, sourceHash, newIndex);

    addedCount++;
    modified = true;
    logVerbose(`Added work_history for commissie ${commissie.commissie_name} (index ${newIndex})`);
  }

  // Handle unchanged commissies when force=true (update with current data including start_date)
  if (force) {
    for (const commissie of changes.unchanged) {
      const commissieRondoClubId = commissieMap.get(commissie.commissie_name);
      if (!commissieRondoClubId) continue;

      // Find the tracked entry to get its index (match by both commissie_name and role_name)
      const trackedHistory = getMemberCommissieWorkHistory(db, knvb_id);
      const tracked = trackedHistory.find(h =>
        h.commissie_name === commissie.commissie_name &&
        (h.role_name || null) === (commissie.role_name || null)
      );
      if (tracked && tracked.rondo_club_work_history_id !== null && tracked.rondo_club_work_history_id < newWorkHistory.length) {
        const index = tracked.rondo_club_work_history_id;
        if (!commissie.role_name) {
          logVerbose(`Warning: Commissie "${commissie.commissie_name}" has no role_name for ${knvb_id}, skipping`);
          continue;
        }
        const entry = buildWorkHistoryEntry(
          commissieRondoClubId,
          commissie.role_name,
          commissie.is_active !== false,
          commissie.relation_start,
          commissie.relation_end
        );
        newWorkHistory[index] = entry;
        modified = true;
        logVerbose(`Force-updated work_history for commissie ${commissie.commissie_name} role ${commissie.role_name} (index ${index})`);
      }
    }
  }

  // Update WordPress if modified
  if (modified) {
    try {
      await rondoClubRequest(
        `wp/v2/people/${rondo_club_id}`,
        'PUT',
        { acf: { first_name: existingFirstName, last_name: existingLastName, work_history: newWorkHistory } },
        options
      );
    } catch (error) {
      logVerbose(`Error updating work_history for ${knvb_id}:`, error.message);
      if (error.details) {
        logVerbose('Error details:', JSON.stringify(error.details, null, 2));
      }
      logVerbose('Payload was:', JSON.stringify(newWorkHistory, null, 2));
      throw error;
    }
    return { action: 'updated', added: addedCount, ended: endedCount };
  }

  return { action: 'unchanged', added: 0, ended: 0 };
}

/**
 * Main sync orchestration for commissie work history.
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all
 * @returns {Promise<Object>} - Sync result
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false, onProgress = null } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;

  const result = {
    success: true,
    total: 0,
    synced: 0,
    created: 0,
    ended: 0,
    skipped: 0,
    errors: []
  };

  try {
    const db = openDb();

    try {
      // Load commissie mapping
      const commissies = getAllCommissies(db);
      const commissieMap = new Map(commissies.map(c => [c.commissie_name, c.rondo_club_id]));
      logVerbose(`Loaded ${commissies.length} commissies from Rondo Club`);

      if (commissies.length === 0) {
        logVerbose('No commissies found. Run commissie sync first.');
        return result;
      }

      // Load member functions and committees
      const memberFunctions = getAllActiveMemberFunctions(db);
      const memberCommittees = getAllActiveMemberCommittees(db);

      logVerbose(`Found ${memberFunctions.length} member functions, ${memberCommittees.length} committee memberships`);

      // Build commissie work history records
      // Functions go to "Verenigingsbreed", committees go to their commissie
      const workHistoryRecords = [];
      const memberCommissies = new Map(); // Map<knvb_id, Array<{commissie_name, role_name, is_active, relation_start, relation_end}>>

      // Process member functions -> Verenigingsbreed
      for (const func of memberFunctions) {
        if (!memberCommissies.has(func.knvb_id)) {
          memberCommissies.set(func.knvb_id, []);
        }
        memberCommissies.get(func.knvb_id).push({
          commissie_name: 'Verenigingsbreed',
          role_name: func.function_description,
          is_active: true,
          relation_start: func.relation_start,
          relation_end: func.relation_end
        });
        workHistoryRecords.push({
          knvb_id: func.knvb_id,
          commissie_name: 'Verenigingsbreed',
          is_backfill: false,
          role_name: func.function_description,
          is_active: true
        });
      }

      // Process member committees -> their commissie
      for (const comm of memberCommittees) {
        if (!memberCommissies.has(comm.knvb_id)) {
          memberCommissies.set(comm.knvb_id, []);
        }
        memberCommissies.get(comm.knvb_id).push({
          commissie_name: comm.committee_name,
          role_name: comm.role_name,
          is_active: true,
          relation_start: comm.relation_start,
          relation_end: comm.relation_end
        });
        workHistoryRecords.push({
          knvb_id: comm.knvb_id,
          commissie_name: comm.committee_name,
          is_backfill: false,
          role_name: comm.role_name,
          is_active: true
        });
      }

      logVerbose(`Extracted ${workHistoryRecords.length} commissie work history records`);

      // Upsert to tracking database
      if (workHistoryRecords.length > 0) {
        upsertCommissieWorkHistory(db, workHistoryRecords);
      }

      // Get members needing sync
      const needsSync = getCommissieWorkHistoryNeedingSync(db, force);

      // Group by knvb_id
      const memberMap = new Map();
      for (const record of needsSync) {
        if (!memberMap.has(record.knvb_id)) {
          memberMap.set(record.knvb_id, {
            knvb_id: record.knvb_id,
            rondo_club_id: record.rondo_club_id
          });
        }
      }

      const membersToSync = Array.from(memberMap.values());
      result.total = membersToSync.length;
      logVerbose(`${result.total} members need commissie work history sync`);

      // Sync each member
      for (let i = 0; i < membersToSync.length; i++) {
        const member = membersToSync[i];
        const currentCommissies = memberCommissies.get(member.knvb_id) || [];
        logVerbose(`Syncing ${i + 1}/${result.total}: ${member.knvb_id}`);
        if (onProgress) {
          onProgress({ current: i + 1, total: membersToSync.length, label: member.knvb_id });
        }

        try {
          const syncResult = await syncCommissieWorkHistoryForMember(
            member,
            currentCommissies,
            db,
            commissieMap,
            options,
            force
          );
          if (syncResult.action === 'updated') {
            result.synced++;
            result.created += syncResult.added;
            result.ended += syncResult.ended;
          } else if (syncResult.action === 'skipped') {
            result.skipped++;
          }
        } catch (error) {
          result.errors.push({
            knvb_id: member.knvb_id,
            message: error.message
          });
        }
      }

      result.success = result.errors.length === 0;
    } finally {
      db.close();
    }

    return result;
  } catch (error) {
    result.success = false;
    result.error = error.message;
    logError(`Commissie work history sync error: ${error.message}`);
    return result;
  }
}

module.exports = { runSync, syncCommissieWorkHistoryForMember };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  const options = { verbose, force };

  runSync(options)
    .then(result => {
      console.log(`Commissie work history sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Ended: ${result.ended}`);
      console.log(`  Skipped: ${result.skipped}`);
      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.error(`    - ${e.knvb_id}: ${e.message}`));
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
