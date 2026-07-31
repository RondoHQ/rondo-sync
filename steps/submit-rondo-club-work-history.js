require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb: openLapostaDb, getLatestSportlinkResults } = require('../lib/laposta-db');
const {
  openDb,
  getAllTeams,
  upsertWorkHistory,
  getWorkHistoryNeedingSync,
  getMemberWorkHistory,
  updateWorkHistorySyncState,
  deleteWorkHistory,
  getTeamMemberRole,
  getAllCurrentTeamAssignments,
  resolveTeamForMember,
  getWorkHistoryByMember,
  getAllTrackedMembers,
  computeWorkHistoryHash
} = require('../lib/rondo-club-db');

function isValidTeamName(teamName) {
  return Boolean(teamName);
}

/**
 * Extract the current team-presence snapshot from the member search export.
 * This is retained as a safety net when one individual roster request times
 * out: a partial roster download must never end a whole team's assignments.
 */
function extractMemberTeams(sportlinkMember) {
  const teamSet = new Set();
  for (const value of [sportlinkMember.UnionTeams, sportlinkMember.ClubTeams]) {
    const teamValue = String(value || '').trim();
    if (!teamValue) continue;
    teamValue
      .split(',')
      .map(team => team.trim())
      .filter(isValidTeamName)
      .forEach(team => teamSet.add(team));
  }
  return Array.from(teamSet);
}

/**
 * Look up team rondo_club_id by team code or name.
 * First tries the teamMap (team_code/team_name), then falls back to
 * sportlink_team_members for ambiguous codes.
 * @param {string} teamCode - Team code or name to look up
 * @param {Map} teamMap - Map<team_code/team_name, rondo_club_id>
 * @param {Object} [db] - Database for fallback lookup
 * @param {string} [knvbId] - Member KNVB ID for fallback lookup
 * @returns {number|undefined} - Rondo Club ID or undefined if not found
 */
function lookupTeamRondoClubId(teamCode, teamMap, db, knvbId) {
  const result = teamMap.get(teamCode);
  if (result) return result;
  // Fallback: use sportlink_team_members to resolve ambiguous codes
  if (db && knvbId) {
    return resolveTeamForMember(db, knvbId, teamCode) || undefined;
  }
  return undefined;
}

/**
 * Convert JS Date to ACF date format (YYYYMMDD).
 * @param {Date} date - Date object
 * @returns {string} - ACF date string
 */
function formatDateForFields(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Get job title for a team assignment.
 * Looks up role from sportlink_team_members table.
 * @param {Object} db - Rondo Club database connection
 * @param {string} knvbId - Member KNVB ID
 * @param {string} teamName - Team name to lookup role for
 * @returns {string|null} - Role description or null if not found
 */
function getJobTitleForTeam(db, knvbId, teamName) {
  return getTeamMemberRole(db, knvbId, teamName);
}

function sameId(left, right) {
  return left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right);
}

/**
 * Find the actual ACF row for a team assignment. Work-history is a shared
 * repeater: player-history and commissie syncs can insert rows and invalidate
 * the array index stored in SQLite. Treat the stored index as a hint only.
 */
function findTeamWorkHistoryIndex(workHistory, expectedIndex, teamRondoClubId) {
  if (!teamRondoClubId) return -1;

  if (
    Number.isInteger(expectedIndex) &&
    expectedIndex >= 0 &&
    expectedIndex < workHistory.length &&
    sameId(workHistory[expectedIndex]?.team_id, teamRondoClubId) &&
    workHistory[expectedIndex]?.is_current !== false
  ) {
    return expectedIndex;
  }

  const currentIndex = workHistory.findIndex(entry => (
    sameId(entry?.team_id, teamRondoClubId) && entry?.is_current !== false
  ));
  if (currentIndex >= 0) return currentIndex;
  return -1;
}

/**
 * Build ACF work_history entry for a team.
 * @param {number} teamRondoClubId - Team WordPress post ID
 * @param {boolean} isBackfill - Is this a backfilled entry
 * @param {string} jobTitle - Job title (required)
 * @returns {Object} - ACF work_history entry
 */
function buildWorkHistoryEntry(teamRondoClubId, isBackfill, jobTitle) {
  return {
    job_title: jobTitle,
    is_current: true,
    start_date: isBackfill ? null : formatDateForFields(new Date()),
    end_date: null,
    team_id: teamRondoClubId
  };
}

/**
 * Detect team changes for a member.
 * Compares current teams from Sportlink vs tracked teams in SQLite.
 * @param {Object} db - SQLite database connection
 * @param {string} knvbId - Member KNVB ID
 * @param {Array<string>} currentTeams - Current team names from Sportlink
 * @returns {Object} - { added: [], removed: [], unchanged: [] }
 */
function detectTeamChanges(db, knvbId, currentTeams) {
  const trackedHistory = getMemberWorkHistory(db, knvbId);
  const trackedTeams = trackedHistory.map(h => ({
    team_name: h.team_name,
    rondo_club_work_history_id: h.rondo_club_work_history_id,
    source_hash: h.source_hash,
    last_synced_hash: h.last_synced_hash
  }));

  // Build map of tracked team names with their sync status
  const trackedTeamMap = new Map(trackedTeams.map(t => [t.team_name, t.rondo_club_work_history_id]));
  const currentTeamSet = new Set(currentTeams);

  // Teams that need to be added:
  // 1. Not in tracked teams at all
  // 2. In tracked teams but rondo_club_work_history_id is NULL (never synced to WordPress)
  const added = currentTeams.filter(t => {
    if (!trackedTeamMap.has(t)) {
      return true; // Not tracked at all
    }
    const rondoClubWorkHistoryId = trackedTeamMap.get(t);
    return rondoClubWorkHistoryId === null || rondoClubWorkHistoryId === undefined; // Tracked but never synced
  });

  const removed = trackedTeams.filter(t => !currentTeamSet.has(t.team_name));

  // Only teams that are both tracked AND have a rondo_club_work_history_id are truly unchanged
  const unchanged = currentTeams.filter(t => {
    if (!trackedTeamMap.has(t)) {
      return false; // Not tracked
    }
    const rondoClubWorkHistoryId = trackedTeamMap.get(t);
    return rondoClubWorkHistoryId !== null && rondoClubWorkHistoryId !== undefined; // Tracked and synced
  });

  const updated = unchanged.filter(teamName => {
    const tracked = trackedHistory.find(history => history.team_name === teamName);
    return tracked && tracked.source_hash !== tracked.last_synced_hash;
  });

  return { added, removed, unchanged, updated };
}

/**
 * Sync work history for a single member.
 * Detects team changes and updates WordPress work_history ACF field.
 * @param {Object} member - Member with KNVB ID and current teams
 * @param {Array<string>} currentTeams - Current team names
 * @param {Object} db - Rondo Club SQLite database
 * @param {Map} teamMap - Map<team_code, rondo_club_id>
 * @param {Object} options - Logger and verbose options
 * @param {boolean} force - Force update even unchanged entries
 * @returns {Promise<{action: string, added: number, ended: number, updated: number}>}
 */
async function syncWorkHistoryForMember(member, currentTeams, db, teamMap, options, force = false) {
  const { knvb_id, rondo_club_id } = member;
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Skip if member not yet synced to Rondo Club
  if (!rondo_club_id) {
    logVerbose(`Skipping ${knvb_id}: not yet synced to Rondo Club`);
    return { action: 'skipped', added: 0, ended: 0 };
  }

  // Detect changes
  const changes = detectTeamChanges(db, knvb_id, currentTeams);
  logVerbose(`Member ${knvb_id}: ${changes.added.length} added, ${changes.removed.length} removed, ${changes.updated.length} role-updated, ${changes.unchanged.length} unchanged`);

  // Fetch existing data from WordPress
  let existingWorkHistory = [];
  let existingFirstName = '';
  let existingLastName = '';
  try {
    const response = await rondoClubRequest(`wp/v2/people/${rondo_club_id}`, 'GET', null, options);
    existingWorkHistory = response.body.fields?.work_history || [];
    existingFirstName = response.body.fields?.first_name || '';
    existingLastName = response.body.fields?.last_name || '';
  } catch (error) {
    logVerbose(`Could not fetch existing data for ${knvb_id}: ${error.message}`);
  }

  let addedCount = 0;
  let endedCount = 0;
  let updatedCount = 0;
  let modified = false;
  const trackingDeletes = [];
  const trackingUpdates = [];

  // Build new work_history array
  const newWorkHistory = [...existingWorkHistory];

  // Handle removed teams. Resolve by team identity because the saved repeater
  // index can drift whenever another pipeline inserts work-history rows.
  for (const removed of changes.removed) {
    const teamRondoClubId = lookupTeamRondoClubId(removed.team_name, teamMap, db, knvb_id);
    const index = findTeamWorkHistoryIndex(
      newWorkHistory,
      removed.rondo_club_work_history_id,
      teamRondoClubId
    );
    if (index >= 0) {
      newWorkHistory[index] = {
        ...newWorkHistory[index],
        is_current: false,
        end_date: formatDateForFields(new Date())
      };
      endedCount++;
      modified = true;
      logVerbose(`Ended work_history for team ${removed.team_name} (index ${index})`);
    } else {
      logVerbose(`Could not find a current ACF row for removed team ${removed.team_name}; clearing stale tracking only`);
    }
    trackingDeletes.push(removed.team_name);
  }

  // Handle added teams
  for (const teamName of changes.added) {
    const teamStadionId = lookupTeamRondoClubId(teamName, teamMap, db, knvb_id);
    if (!teamStadionId) {
      logVerbose(`Warning: Team "${teamName}" not found in Rondo Club, skipping`);
      continue;
    }

    // Check if this is initial sync (backfill) or new team
    const isBackfill = !getMemberWorkHistory(db, knvb_id).some(h => h.last_synced_at);
    const jobTitle = getJobTitleForTeam(db, knvb_id, teamName);
    if (!jobTitle) {
      logVerbose(`Warning: No role description for ${knvb_id} in team ${teamName}, skipping`);
      continue;
    }
    const existingIndex = findTeamWorkHistoryIndex(newWorkHistory, null, teamStadionId);
    const newIndex = existingIndex >= 0 ? existingIndex : newWorkHistory.length;
    if (existingIndex >= 0) {
      newWorkHistory[existingIndex] = {
        ...newWorkHistory[existingIndex],
        job_title: jobTitle,
        is_current: true,
        end_date: '',
        team_id: teamStadionId
      };
      updatedCount++;
    } else {
      newWorkHistory.push(buildWorkHistoryEntry(teamStadionId, isBackfill, jobTitle));
      addedCount++;
    }

    const sourceHash = computeWorkHistoryHash(knvb_id, teamName, jobTitle);
    trackingUpdates.push({ teamName, sourceHash, index: newIndex });
    modified = true;
    logVerbose(`Added work_history for team ${teamName} (index ${newIndex})`);
  }

  // Refresh unchanged teams during a force run, and automatically update rows
  // whose role description changed in Sportlink.
  const teamsToRefresh = force ? changes.unchanged : changes.updated;
  if (teamsToRefresh.length > 0) {
    const trackedHistory = getMemberWorkHistory(db, knvb_id);
    for (const teamName of teamsToRefresh) {
      const teamStadionId = lookupTeamRondoClubId(teamName, teamMap, db, knvb_id);
      if (!teamStadionId) {
        logVerbose(`Warning: Team "${teamName}" not found in Rondo Club, skipping`);
        continue;
      }

      const jobTitle = getJobTitleForTeam(db, knvb_id, teamName);
      if (!jobTitle) {
        logVerbose(`Warning: No role description for ${knvb_id} in team ${teamName}, skipping`);
        continue;
      }
      const tracked = trackedHistory.find(h => h.team_name === teamName);

      const index = findTeamWorkHistoryIndex(
        newWorkHistory,
        tracked?.rondo_club_work_history_id,
        teamStadionId
      );
      if (index >= 0) {
        newWorkHistory[index] = {
          ...newWorkHistory[index],
          job_title: jobTitle,
          is_current: true,
          end_date: '',
          team_id: teamStadionId
        };
        updatedCount++;
        modified = true;
        trackingUpdates.push({
          teamName,
          sourceHash: computeWorkHistoryHash(knvb_id, teamName, jobTitle),
          index
        });
        logVerbose(`Updated work_history for team ${teamName} (index ${index}) with job_title: ${jobTitle}`);
      } else {
        const isBackfill = !trackedHistory.some(h => h.last_synced_at);
        const newIndex = newWorkHistory.length;
        newWorkHistory.push(buildWorkHistoryEntry(teamStadionId, isBackfill, jobTitle));
        trackingUpdates.push({
          teamName,
          sourceHash: computeWorkHistoryHash(knvb_id, teamName, jobTitle),
          index: newIndex
        });
        addedCount++;
        modified = true;
        logVerbose(`Created work_history for team ${teamName} (index ${newIndex}) with job_title: ${jobTitle}`);
      }
    }
  }

  // Update WordPress if modified
  if (modified) {
    try {
      await rondoClubRequest(
        `wp/v2/people/${rondo_club_id}`,
        'PUT',
        { fields: { first_name: existingFirstName, last_name: existingLastName, work_history: newWorkHistory } },
        options
      );
      for (const teamName of trackingDeletes) {
        deleteWorkHistory(db, knvb_id, teamName);
      }
      for (const update of trackingUpdates) {
        updateWorkHistorySyncState(db, knvb_id, update.teamName, update.sourceHash, update.index);
      }
    } catch (error) {
      logVerbose(`Error updating work_history for ${knvb_id}:`, error.message);
      if (error.details) {
        logVerbose('Error details:', JSON.stringify(error.details, null, 2));
      }
      logVerbose('Payload was:', JSON.stringify(newWorkHistory, null, 2));
      throw error;
    }
    return { action: 'updated', added: addedCount, ended: endedCount, updated: updatedCount };
  }

  for (const teamName of trackingDeletes) {
    deleteWorkHistory(db, knvb_id, teamName);
  }

  return { action: 'unchanged', added: 0, ended: 0, updated: 0 };
}

/**
 * Main sync orchestration for work history.
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all
 * @param {boolean} [options.backfillOnly=false] - Only process members not yet synced
 * @returns {Promise<Object>} - Sync result
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false, backfillOnly = false } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;

  const result = {
    success: true,
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    ended: 0,
    skipped: 0,
    errors: []
  };

  try {
    // Open databases
    const lapostaDb = openLapostaDb();
    const rondoClubDb = openDb();

    try {
      // Load Sportlink data
      const resultsJson = getLatestSportlinkResults(lapostaDb);
      if (!resultsJson) {
        const errorMsg = 'No Sportlink results found. Run download first.';
        logError(errorMsg);
        result.success = false;
        result.error = errorMsg;
        return result;
      }

      const sportlinkData = JSON.parse(resultsJson);
      const members = Array.isArray(sportlinkData.Members) ? sportlinkData.Members : [];
      logVerbose(`Found ${members.length} Sportlink members`);

      // Load team mapping: team_code/team_name -> rondo_club_id
      // SearchMembers returns a mix of team codes (e.g. "JO17-1") and full team names (e.g. "AWC")
      const teams = getAllTeams(rondoClubDb);
      const teamMap = new Map();
      // Track team_codes that appear more than once (ambiguous - don't use for lookup)
      const codeCount = new Map();
      for (const t of teams) {
        if (t.team_code) codeCount.set(t.team_code, (codeCount.get(t.team_code) || 0) + 1);
      }
      for (const t of teams) {
        // Only use team_code for lookup if it's unambiguous (one team per code)
        if (t.team_code && codeCount.get(t.team_code) === 1) {
          teamMap.set(t.team_code, t.rondo_club_id);
        }
        if (t.team_name) teamMap.set(t.team_name, t.rondo_club_id);
      }
      logVerbose(`Loaded ${teams.length} teams from Rondo Club (${teamMap.size} lookup entries)`);

      // Build current presence from both the member-search export and the team
      // rosters downloaded immediately before this step. The former prevents
      // false removals after a partial roster timeout; the latter supplies the
      // canonical team name and exact role description.
      const workHistoryRecords = [];
      const memberTeams = new Map(); // Map<knvb_id, { teams: [] }>

      for (const member of members) {
        const knvbId = member.PublicPersonId;
        if (!knvbId) continue;
        memberTeams.set(knvbId, { teams: extractMemberTeams(member) });
      }

      const seenAssignments = new Set();
      for (const assignment of getAllCurrentTeamAssignments(rondoClubDb)) {
        const key = `${assignment.knvb_id}\u0000${assignment.team_name}`;
        if (seenAssignments.has(key)) continue;
        seenAssignments.add(key);

        if (!memberTeams.has(assignment.knvb_id)) {
          memberTeams.set(assignment.knvb_id, { teams: [] });
        }
        const currentTeams = memberTeams.get(assignment.knvb_id).teams;
        if (!currentTeams.includes(assignment.team_name)) {
          currentTeams.push(assignment.team_name);
        }
        workHistoryRecords.push({
          knvb_id: assignment.knvb_id,
          team_name: assignment.team_name,
          role_description: assignment.role_description,
          is_backfill: backfillOnly
        });
      }

      logVerbose(`Extracted ${workHistoryRecords.length} work history records`);

      // Upsert to tracking database
      if (workHistoryRecords.length > 0) {
        upsertWorkHistory(rondoClubDb, workHistoryRecords);
      }

      // Get members needing sync
      const needsSync = backfillOnly
        ? getWorkHistoryNeedingSync(rondoClubDb, true)
        : getWorkHistoryNeedingSync(rondoClubDb, force);

      // Group by knvb_id
      const memberMap = new Map();
      for (const record of needsSync) {
        if (!memberMap.has(record.knvb_id)) {
          memberMap.set(record.knvb_id, {
            knvb_id: record.knvb_id,
            rondo_club_id: record.rondo_club_id,
            teams: []
          });
        }
        memberMap.get(record.knvb_id).teams.push(record.team_name);
      }

      // A disappearance creates no new source row, so it cannot show up in
      // the hash query above. Explicitly queue members whose current Sportlink
      // team set differs from the set tracked in SQLite, including people who
      // now have no team at all or disappeared from the latest member export.
      if (!backfillOnly) {
        const trackedByMember = getWorkHistoryByMember(rondoClubDb);
        const trackedMembers = new Map(getAllTrackedMembers(rondoClubDb).map(row => [row.knvb_id, row]));
        for (const [knvbId, trackedTeams] of trackedByMember) {
          const currentTeams = new Set(memberTeams.get(knvbId)?.teams || []);
          const differs = trackedTeams.size !== currentTeams.size ||
            Array.from(trackedTeams).some(teamName => !currentTeams.has(teamName));
          if (!differs || memberMap.has(knvbId)) continue;

          const trackedMember = trackedMembers.get(knvbId);
          if (!trackedMember?.rondo_club_id) continue;
          memberMap.set(knvbId, {
            knvb_id: knvbId,
            rondo_club_id: trackedMember.rondo_club_id,
            teams: []
          });
        }
      }

      const membersToSync = Array.from(memberMap.values());
      result.total = membersToSync.length;
      logVerbose(`${result.total} members need work history sync`);

      // Sync each member
      for (let i = 0; i < membersToSync.length; i++) {
        const member = membersToSync[i];
        const memberData = memberTeams.get(member.knvb_id) || { teams: [] };
        const currentTeams = memberData.teams;
        logVerbose(`Syncing ${i + 1}/${result.total}: ${member.knvb_id}`);

        try {
          const syncResult = await syncWorkHistoryForMember(
            member,
            currentTeams,
            rondoClubDb,
            teamMap,
            options,
            force
          );
          if (syncResult.action === 'updated') {
            result.synced++;
            result.created += syncResult.added;
            result.updated += syncResult.updated;
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
      lapostaDb.close();
      rondoClubDb.close();
    }

    return result;
  } catch (error) {
    result.success = false;
    result.error = error.message;
    logError(`Work history sync error: ${error.message}`);
    return result;
  }
}

module.exports = {
  runSync,
  detectTeamChanges,
  findTeamWorkHistoryIndex
};

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');
  const backfillOnly = process.argv.includes('--backfill-only');

  const options = { verbose, force, backfillOnly };

  runSync(options)
    .then(result => {
      console.log(`Work history sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Updated: ${result.updated}`);
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
