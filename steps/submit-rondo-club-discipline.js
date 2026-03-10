require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const {
  openDb: openDisciplineDb,
  getCasesNeedingSync,
  updateCaseSyncState,
  getSeasonFromDate,
  getAllCases,
  getStaleSyncedCases
} = require('../lib/discipline-db');
const { openDb: openRondoClubDb, getTeamBySportlinkId } = require('../lib/rondo-club-db');
const { readEnv } = require('../lib/utils');

/**
 * Convert date string to ACF Ymd format (e.g., "2026-01-15" -> "20260115")
 * @param {string} dateString - Date in various formats (ISO, etc.)
 * @returns {string} - Date in Ymd format, or empty string if invalid
 */
function toAcfDateFormat(dateString) {
  if (!dateString) return '';

  // Try to parse the date
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}${month}${day}`;
}

/**
 * Build knvb_id -> rondo_club_id lookup map from rondo-sync.sqlite
 * @returns {Map<string, number>} - Map of KNVB ID to Rondo Club person ID
 */
function buildPersonRondoClubIdLookup() {
  const db = openRondoClubDb();
  const stmt = db.prepare('SELECT knvb_id, rondo_club_id FROM rondo_club_members WHERE rondo_club_id IS NOT NULL');
  const rows = stmt.all();
  db.close();

  const lookup = new Map();
  rows.forEach(row => {
    lookup.set(row.knvb_id, row.rondo_club_id);
  });
  return lookup;
}

/**
 * Fetch person name from Rondo Club for title construction
 * @param {number} rondoClubId - WordPress person post ID
 * @param {Object} options - Logger options
 * @param {Map<number, string>} cache - Cache for person names
 * @returns {Promise<string>} - Person name
 */
async function fetchPersonName(rondoClubId, options, cache) {
  if (cache.has(rondoClubId)) {
    return cache.get(rondoClubId);
  }

  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  try {
    const response = await rondoClubRequest(`wp/v2/people/${rondoClubId}`, 'GET', null, options);
    const person = response.body;
    let name = person.title?.rendered || person.title;

    // If title not available, construct from ACF
    if (!name && person.acf) {
      const firstName = person.acf.first_name || '';
      const lastName = person.acf.last_name || '';
      name = `${firstName} ${lastName}`.trim();
    }

    if (!name) {
      name = `Person ${rondoClubId}`;
    }

    cache.set(rondoClubId, name);
    return name;
  } catch (error) {
    logVerbose(`  Error fetching person ${rondoClubId}: ${error.message}`);
    const fallbackName = `Person ${rondoClubId}`;
    cache.set(rondoClubId, fallbackName);
    return fallbackName;
  }
}

/**
 * Get or create season term in Rondo Club WordPress
 * @param {string} seasonName - Season string (e.g., "2025-2026")
 * @param {Object} options - Logger options
 * @param {Map<string, number>} cache - Cache for season term IDs
 * @returns {Promise<number>} - Term ID
 */
async function getOrCreateSeasonTermId(seasonName, options, cache) {
  if (cache.has(seasonName)) {
    return cache.get(seasonName);
  }

  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  try {
    // Try to fetch existing term
    const response = await rondoClubRequest(`wp/v2/seizoen?slug=${seasonName}`, 'GET', null, options);
    const terms = response.body;

    if (terms && terms.length > 0) {
      const termId = terms[0].id;
      cache.set(seasonName, termId);
      logVerbose(`  Found existing season term: ${seasonName} (ID: ${termId})`);
      return termId;
    }

    // Create new term
    const createResponse = await rondoClubRequest('wp/v2/seizoen', 'POST', {
      name: seasonName,
      slug: seasonName
    }, options);
    const termId = createResponse.body.id;
    cache.set(seasonName, termId);
    logVerbose(`  Created new season term: ${seasonName} (ID: ${termId})`);
    return termId;
  } catch (error) {
    console.error(`Error getting/creating season term "${seasonName}": ${error.message}`);
    throw error;
  }
}

/**
 * Build case title from person name, match description, and date
 * @param {string} personName - Person name
 * @param {string} matchDescription - Match description
 * @param {string} matchDate - Match date (ISO format)
 * @returns {string} - Formatted title
 */
function buildCaseTitle(personName, matchDescription, matchDate) {
  return `${personName} - ${matchDescription} - ${matchDate}`;
}

/**
 * Sync a single discipline case to Rondo Club (create or update)
 * @param {Object} caseData - Case record from database
 * @param {number} personRondoClubId - Rondo Club person post ID
 * @param {number} seasonTermId - Season term ID
 * @param {string} personName - Person name for title
 * @param {Object} db - Discipline database connection
 * @param {Object} options - Logger and verbose options
 * @param {number|null} homeTeamRondoClubId - WordPress team post ID for home team (or null)
 * @param {number|null} awayTeamRondoClubId - WordPress team post ID for away team (or null)
 * @returns {Promise<{action: string, id: number}>}
 */
async function syncCase(caseData, personRondoClubId, seasonTermId, personName, db, options, homeTeamRondoClubId = null, awayTeamRondoClubId = null) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  let { rondo_club_id } = caseData;
  const { dossier_id, source_hash, last_synced_hash, match_date, match_description } = caseData;

  // Check if update needed (unless force)
  if (rondo_club_id && !options.force && source_hash === last_synced_hash) {
    logVerbose(`Case unchanged, skipping: ${dossier_id}`);
    return { action: 'skipped', id: rondo_club_id };
  }

  // Build ACF fields payload
  // Note: Date fields use ACF date_picker with Ymd return format (e.g., "20260115")
  const sportlinkIsCharged = caseData.is_charged === 1;
  const acfFields = {
    'dossier_id': dossier_id,
    'person': personRondoClubId,
    'match_date': toAcfDateFormat(match_date),
    'match_description': match_description || '',
    'team_name': caseData.team_name || '',
    'charge_codes': caseData.charge_codes || '',
    'charge_description': caseData.charge_description || '',
    'sanction_description': caseData.sanction_description || '',
    'processing_date': toAcfDateFormat(caseData.processing_date),
    'administrative_fee': caseData.administrative_fee ? parseFloat(caseData.administrative_fee) : null,
    'is_charged': sportlinkIsCharged ? 'sportlink' : '',
    'home_team': homeTeamRondoClubId || '',
    'away_team': awayTeamRondoClubId || ''
  };

  const title = buildCaseTitle(personName, match_description || 'Unknown Match', match_date || 'Unknown Date');
  const season = getSeasonFromDate(match_date);

  const payload = {
    title: title,
    status: 'publish',
    seizoen: [seasonTermId],
    acf: acfFields
  };

  if (rondo_club_id) {
    // UPDATE existing case
    // Do not overwrite is_charged with '' when Sportlink doesn't charge this case.
    // Rondo Club may have set is_charged to 'rondo' when an invoice was sent.
    // Only send is_charged in the update payload when Sportlink explicitly charges it.
    if (!sportlinkIsCharged) {
      delete payload.acf['is_charged'];
    }
    const endpoint = `wp/v2/discipline-cases/${rondo_club_id}`;
    logVerbose(`Updating discipline case: ${rondo_club_id} - ${dossier_id}`);
    logVerbose(`  PUT ${endpoint}`);
    logVerbose(`  Payload: ${JSON.stringify(payload, null, 2)}`);

    try {
      const response = await rondoClubRequest(endpoint, 'PUT', payload, options);
      updateCaseSyncState(db, dossier_id, source_hash, rondo_club_id, season);
      return { action: 'updated', id: rondo_club_id };
    } catch (error) {
      // Check if case was deleted in WordPress (404)
      if (error.details?.code === 'rest_post_invalid_id' || error.details?.data?.status === 404) {
        logVerbose(`Case ${dossier_id} (ID: ${rondo_club_id}) no longer exists in WordPress, recreating...`);
        // Clear the rondo_club_id so we fall through to create
        rondo_club_id = null;
        updateCaseSyncState(db, dossier_id, null, null, null);
      } else {
        console.error(`API Error updating case "${dossier_id}" (ID: ${rondo_club_id}):`);
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

  // CREATE new case (or recreate if deleted from WordPress)
  if (!rondo_club_id) {
    const endpoint = 'wp/v2/discipline-cases';
    logVerbose(`Creating new discipline case: ${dossier_id}`);
    logVerbose(`  POST ${endpoint}`);
    logVerbose(`  Payload: ${JSON.stringify(payload, null, 2)}`);

    try {
      const response = await rondoClubRequest(endpoint, 'POST', payload, options);
      const newId = response.body.id;
      updateCaseSyncState(db, dossier_id, source_hash, newId, season);
      return { action: 'created', id: newId };
    } catch (error) {
      console.error(`API Error creating case "${dossier_id}":`);
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
 * Resolve a WordPress user ID to assign todos to (Secretaris).
 * @param {Object} rondoClubDb - rondo-sync.sqlite connection
 * @param {Object} options - Logger options
 * @returns {Promise<number|null>} - WordPress user ID or null
 */
async function resolveTaskAssignee(rondoClubDb, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  // Check for configured assignee
  const configuredUserId = Number.parseInt(readEnv('DISCIPLINE_TASK_ASSIGNEE_USER_ID', ''), 10);
  if (Number.isFinite(configuredUserId) && configuredUserId > 0) {
    return configuredUserId;
  }

  // Fall back to Secretaris
  const row = rondoClubDb.prepare(`
    SELECT rcm.rondo_club_id
    FROM sportlink_member_functions smf
    INNER JOIN rondo_club_members rcm ON rcm.knvb_id = smf.knvb_id
    WHERE smf.is_active = 1
      AND rcm.rondo_club_id IS NOT NULL
      AND lower(smf.function_description) LIKE '%secretaris%'
    ORDER BY
      CASE WHEN lower(smf.function_description) = 'secretaris' THEN 0 ELSE 1 END ASC,
      smf.id ASC
    LIMIT 1
  `).get();

  if (!row) return null;

  try {
    const response = await rondoClubRequest('rondo/v1/users', 'GET', null, options);
    const users = Array.isArray(response.body) ? response.body : [];
    const userByPerson = users.find(u => Number(u.linked_person_id) === Number(row.rondo_club_id));
    if (userByPerson?.id) {
      logVerbose(`  Resolved Secretaris assignee: user ${userByPerson.id}`);
      return userByPerson.id;
    }
  } catch (error) {
    logVerbose(`  Could not resolve assignee: ${error.message}`);
  }

  return null;
}

/**
 * Create a todo on a person when their discipline case is trashed due to reassignment.
 * @param {number} personRondoClubId - WordPress person post ID
 * @param {string} dossierId - Dossier ID of the trashed case
 * @param {number|null} assigneeUserId - WordPress user ID to assign the todo to
 * @param {Object} options - Logger options
 */
async function createReassignmentTodo(personRondoClubId, dossierId, assigneeUserId, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const payload = {
    content: `Tuchtzaak ${dossierId} verwijderd — controleer factuur`,
    due_date: dueDate,
    status: 'open',
    notes: `<p>Tuchtzaak <strong>${dossierId}</strong> is door de KNVB toegewezen aan iemand buiten onze club. De tuchtzaak is automatisch verwijderd uit Rondo.</p><p>Controleer of er een factuur gekoppeld is aan deze tuchtzaak. Als dat zo is, moet deze handmatig worden geannuleerd of gecrediteerd.</p>`
  };

  try {
    const createResponse = await rondoClubRequest(
      `rondo/v1/people/${personRondoClubId}/todos`,
      'POST',
      payload,
      options
    );

    const todoId = createResponse.body?.id;
    if (todoId && assigneeUserId) {
      await rondoClubRequest(`wp/v2/todos/${todoId}`, 'PUT', { author: assigneeUserId }, options);
    }

    logVerbose(`  Created todo${todoId ? ` (ID: ${todoId})` : ''} for person ${personRondoClubId}`);
  } catch (error) {
    // Non-fatal: log but don't fail the sync
    console.error(`  Warning: could not create todo for trashed case ${dossierId}: ${error.message}`);
  }
}

/**
 * Main sync orchestration for discipline cases
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose] - Verbose mode
 * @param {boolean} [options.force] - Force sync all cases
 * @returns {Promise<Object>} - Result object with counts
 */
async function runSync(options = {}) {
  const { logger, verbose = false, force = false } = options;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const log = logger?.log.bind(logger) || console.log;

  log('Starting discipline case sync to Rondo Club...');

  // Build person lookup map
  logVerbose('Building person lookup map from rondo-sync.sqlite...');
  const personLookup = buildPersonRondoClubIdLookup();
  logVerbose(`  Loaded ${personLookup.size} person mappings`);

  // Initialize caches
  const personNameCache = new Map();
  const seasonTermCache = new Map();

  // Open discipline database
  const db = openDisciplineDb();

  // Open rondo-club database for team lookups
  const rondoClubDb = openRondoClubDb();

  // Resolve task assignee once (for reassignment todos)
  let taskAssigneeUserId = null;

  // Get cases needing sync
  const cases = getCasesNeedingSync(db, force);
  log(`Found ${cases.length} cases needing sync${force ? ' (force mode)' : ''}`);

  const results = {
    success: true,
    total: cases.length,
    synced: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    skipped_no_person: 0,
    trashed: 0,
    errors: []
  };

  for (const caseData of cases) {
    const { dossier_id, public_person_id, match_date } = caseData;

    // Look up person rondo_club_id
    const personRondoClubId = personLookup.get(public_person_id);
    if (!personRondoClubId) {
      // If this case was previously synced to WordPress, the person was reassigned
      // to someone outside our club. Trash the WordPress post.
      if (caseData.rondo_club_id) {
        log(`Case ${dossier_id} was reassigned to person ${public_person_id} (not in our club). Trashing WordPress post ${caseData.rondo_club_id}...`);
        try {
          // Fetch the old discipline case to find the person it was linked to
          let oldPersonId = null;
          try {
            const caseResponse = await rondoClubRequest(`wp/v2/discipline-cases/${caseData.rondo_club_id}`, 'GET', null, options);
            oldPersonId = caseResponse.body?.acf?.person || null;
          } catch (fetchError) {
            logVerbose(`  Could not fetch old case data: ${fetchError.message}`);
          }

          await rondoClubRequest(`wp/v2/discipline-cases/${caseData.rondo_club_id}`, 'DELETE', null, options);
          log(`  Trashed discipline case post ${caseData.rondo_club_id}`);
          updateCaseSyncState(db, dossier_id, null, null, null);
          results.trashed++;

          // Create a todo on the old person so the invoice can be reviewed
          if (oldPersonId) {
            if (!taskAssigneeUserId) {
              taskAssigneeUserId = await resolveTaskAssignee(rondoClubDb, options);
            }
            await createReassignmentTodo(oldPersonId, dossier_id, taskAssigneeUserId, options);
          }
        } catch (error) {
          if (error.details?.data?.status === 404) {
            logVerbose(`  Post ${caseData.rondo_club_id} already gone, clearing sync state`);
            updateCaseSyncState(db, dossier_id, null, null, null);
            results.trashed++;
          } else {
            console.error(`  Error trashing case ${dossier_id} (post ${caseData.rondo_club_id}): ${error.message}`);
            results.errors.push({ dossier_id, message: `Trash failed: ${error.message}` });
          }
        }
      } else {
        logVerbose(`Skipping case ${dossier_id}: person ${public_person_id} not yet synced to Rondo Club`);
      }
      results.skipped_no_person++;
      continue;
    }

    try {
      // Fetch person name (cached)
      const personName = await fetchPersonName(personRondoClubId, options, personNameCache);

      // Derive season from match date
      const season = getSeasonFromDate(match_date);
      if (!season) {
        logVerbose(`Skipping case ${dossier_id}: no match date`);
        results.skipped++;
        continue;
      }

      // Get or create season term (cached)
      const seasonTermId = await getOrCreateSeasonTermId(season, options, seasonTermCache);

      // Resolve home team
      let homeTeamRondoClubId = null;
      if (caseData.home_team_id) {
        const homeTeam = getTeamBySportlinkId(rondoClubDb, caseData.home_team_id);
        if (homeTeam?.rondo_club_id) {
          homeTeamRondoClubId = homeTeam.rondo_club_id;
        } else {
          logVerbose(`  Home team ${caseData.home_team_id} not found in Rondo Club`);
        }
      }

      // Resolve away team
      let awayTeamRondoClubId = null;
      if (caseData.away_team_id) {
        const awayTeam = getTeamBySportlinkId(rondoClubDb, caseData.away_team_id);
        if (awayTeam?.rondo_club_id) {
          awayTeamRondoClubId = awayTeam.rondo_club_id;
        } else {
          logVerbose(`  Away team ${caseData.away_team_id} not found in Rondo Club`);
        }
      }

      // Sync the case
      const result = await syncCase(caseData, personRondoClubId, seasonTermId, personName, db, options, homeTeamRondoClubId, awayTeamRondoClubId);

      if (result.action === 'created') {
        results.created++;
        results.synced++;
      } else if (result.action === 'updated') {
        results.updated++;
        results.synced++;
      } else if (result.action === 'skipped') {
        results.skipped++;
      }
    } catch (error) {
      results.errors.push({
        dossier_id,
        message: error.message
      });
      console.error(`Error syncing case ${dossier_id}: ${error.message}`);
    }
  }

  // Detect cases that disappeared from Sportlink (reassigned to another club)
  const staleCases = getStaleSyncedCases(db);
  if (staleCases.length > 0) {
    log(`Found ${staleCases.length} synced case(s) no longer in Sportlink download — trashing...`);
    for (const staleCase of staleCases) {
      log(`  Case ${staleCase.dossier_id} (WP post ${staleCase.rondo_club_id}) no longer in Sportlink`);
      try {
        // Fetch the old discipline case to find the person it was linked to
        let oldPersonId = null;
        try {
          const caseResponse = await rondoClubRequest(`wp/v2/discipline-cases/${staleCase.rondo_club_id}`, 'GET', null, options);
          oldPersonId = caseResponse.body?.acf?.person || null;
        } catch (fetchError) {
          logVerbose(`    Could not fetch old case data: ${fetchError.message}`);
        }

        await rondoClubRequest(`wp/v2/discipline-cases/${staleCase.rondo_club_id}`, 'DELETE', null, options);
        log(`    Trashed WordPress post ${staleCase.rondo_club_id}`);
        updateCaseSyncState(db, staleCase.dossier_id, null, null, null);
        results.trashed++;

        // Create a todo on the old person so the invoice can be reviewed
        if (oldPersonId) {
          if (!taskAssigneeUserId) {
            taskAssigneeUserId = await resolveTaskAssignee(rondoClubDb, options);
          }
          await createReassignmentTodo(oldPersonId, staleCase.dossier_id, taskAssigneeUserId, options);
        }
      } catch (error) {
        if (error.details?.data?.status === 404) {
          logVerbose(`    Post ${staleCase.rondo_club_id} already gone, clearing sync state`);
          updateCaseSyncState(db, staleCase.dossier_id, null, null, null);
          results.trashed++;
        } else {
          console.error(`    Error trashing case ${staleCase.dossier_id}: ${error.message}`);
          results.errors.push({ dossier_id: staleCase.dossier_id, message: `Trash failed: ${error.message}` });
        }
      }
    }
  }

  rondoClubDb.close();
  db.close();

  log('Discipline case sync complete.');
  log(`  Synced: ${results.synced}/${results.total}`);
  log(`  Created: ${results.created}`);
  log(`  Updated: ${results.updated}`);
  log(`  Skipped (unchanged): ${results.skipped}`);
  log(`  Skipped (no person): ${results.skipped_no_person}`);
  if (results.trashed > 0) {
    log(`  Trashed (reassigned): ${results.trashed}`);
  }
  if (results.errors.length > 0) {
    log(`  Errors: ${results.errors.length}`);
    results.success = false;
  }

  return results;
}

module.exports = { runSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  runSync({ verbose, force })
    .then(result => {
      console.log(`Discipline cases sync: ${result.synced}/${result.total} synced`);
      console.log(`  Created: ${result.created}`);
      console.log(`  Updated: ${result.updated}`);
      console.log(`  Skipped (unchanged): ${result.skipped}`);
      console.log(`  Skipped (no person): ${result.skipped_no_person}`);
      if (result.trashed > 0) {
        console.log(`  Trashed (reassigned): ${result.trashed}`);
      }
      if (result.errors.length > 0) {
        console.error(`  Errors: ${result.errors.length}`);
        result.errors.forEach(e => console.error(`    - ${e.dossier_id}: ${e.message}`));
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
