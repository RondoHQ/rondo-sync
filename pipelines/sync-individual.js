#!/usr/bin/env node
require('dotenv/config');

const { chromium } = require('playwright');
const { openDb: openLapostaDb, getLatestSportlinkResults } = require('../lib/laposta-db');
const {
  openDb: openRondoClubDb,
  getMemberFreeFieldsByKnvbId,
  getFreeFieldMappings,
  upsertMembers,
  upsertParents,
  getParentsNeedingSync,
  updateSyncState,
  getMemberFunctions,
  getMemberCommittees,
  getAllCommissies,
  upsertMemberFunctions,
  upsertMemberCommittees,
  upsertMemberFreeFields
} = require('../lib/rondo-club-db');
const { preparePerson } = require('../steps/prepare-rondo-club-members');
const { runPrepare: runPrepareParents } = require('../steps/prepare-rondo-club-parents');
const { syncParent } = require('../steps/submit-rondo-club-sync');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { resolveFieldConflicts } = require('../lib/conflict-resolver');
const { TRACKED_FIELDS } = require('../lib/sync-origin');
const { extractFieldValue } = require('../lib/detect-rondo-club-changes');
const { syncCommissieWorkHistoryForMember } = require('../steps/submit-rondo-club-commissie-work-history');
const { runSync: runPlayerHistorySync, syncSingleMember: syncSinglePlayerHistory } = require('../steps/submit-rondo-club-player-history');
const {
  loginToSportlink,
  fetchMemberGeneralData,
  fetchMemberFunctions,
  fetchMemberTeamMemberships,
  fetchMemberDataFromOtherPage,
  parseFunctionsResponse
} = require('../steps/download-functions-from-sportlink');

/**
 * Extract tracked field values from member data
 */
function extractTrackedFieldValues(data) {
  const values = {};
  for (const field of TRACKED_FIELDS) {
    values[field] = extractFieldValue(data, field);
  }
  return values;
}

/**
 * Apply conflict resolutions to update payload
 */
function applyResolutions(originalData, resolutions) {
  const resolvedData = JSON.parse(JSON.stringify(originalData));
  if (!resolvedData.acf) resolvedData.acf = {};

  for (const [field, resolution] of resolutions.entries()) {
    const value = resolution.value;
    if (['email', 'email2', 'mobile', 'phone'].includes(field)) {
      if (!resolvedData.acf.contact_info) resolvedData.acf.contact_info = [];
      const contactInfo = resolvedData.acf.contact_info;
      const existing = contactInfo.findIndex(c => c.contact_type === field);
      if (existing >= 0) {
        contactInfo[existing].contact_value = value;
      } else if (value !== null) {
        contactInfo.push({ contact_type: field, contact_value: value });
      }
    } else {
      const acfFieldName = field.replace(/_/g, '-');
      resolvedData.acf[acfFieldName] = value;
    }
  }
  return resolvedData;
}

function isRetryableMembershipFetchError(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('non-json') ||
    message.includes('json parse') ||
    message.includes('memberteams request failed') ||
    message.includes('failed to fetch') ||
    message.includes('timeout')
  );
}

/**
 * Fetch fresh data from Sportlink for a single member
 * This includes functions, committees, and free fields (VOG, FreeScout ID, etc.)
 */
async function fetchFreshDataFromSportlink(knvbId, db, options = {}) {
  const { verbose = false } = options;
  const log = verbose ? console.log : () => {};

  log('Launching browser to fetch fresh data from Sportlink...');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();

  const logger = {
    log: verbose ? console.log : () => {},
    verbose: verbose ? console.log : () => {},
    error: console.error
  };

  try {
    await loginToSportlink(page, logger);
    log('Logged in to Sportlink');

    // Fetch general member data (person, communication, address, parental info)
    log(`Fetching general data for ${knvbId}...`);
    const memberData = await fetchMemberGeneralData(page, knvbId, logger);

    if (memberData) {
      log(`  Name: ${memberData.FirstName} ${memberData.Infix || ''} ${memberData.LastName}`);
      log(`  Email: ${memberData.Email || 'none'}`);
    }

    // Fetch functions
    log(`Fetching functions for ${knvbId}...`);
    const functionsData = await fetchMemberFunctions(page, knvbId, logger);

    let functions = [];
    let committees = [];

    if (functionsData) {
      const parsed = parseFunctionsResponse(functionsData, knvbId);
      functions = parsed.functions;
      committees = parsed.committees;
      log(`  Found ${functions.length} functions, ${committees.length} committees`);
    }

    // Fetch free fields (Other tab)
    log(`Fetching free fields (Other tab) for ${knvbId}...`);
    const freeFieldsData = await fetchMemberDataFromOtherPage(page, knvbId, logger);

    if (freeFieldsData) {
      log(`  FreeScout ID: ${freeFieldsData.freescout_id || 'none'}`);
      log(`  VOG datum: ${freeFieldsData.vog_datum || 'none'}`);
      log(`  Financial block: ${freeFieldsData.has_financial_block}`);
      log(`  Photo: ${freeFieldsData.photo_url ? 'yes' : 'no'}`);
    }

    // Fetch memberships (for player history sync) in the same authenticated browser session.
    // This endpoint occasionally returns an HTML login page when sessions race/expire.
    let teamMemberships = [];
    log(`Fetching memberships for ${knvbId}...`);
    try {
      teamMemberships = await fetchMemberTeamMemberships(page, knvbId, logger);
    } catch (error) {
      if (!isRetryableMembershipFetchError(error)) {
        throw error;
      }

      log(`  Membership fetch failed (${error.message}). Re-authenticating and retrying once...`);
      try {
        await loginToSportlink(page, logger);
        teamMemberships = await fetchMemberTeamMemberships(page, knvbId, logger);
      } catch (retryError) {
        log(`  Membership fetch still failing after retry: ${retryError.message}`);
        log('  Continuing individual sync without fresh memberships (player history unchanged this run).');
        teamMemberships = [];
      }
    }
    log(`  Membership rows: ${teamMemberships.length}`);

    // Store to database.
    // Always clear existing rows when we got a functions response, even if parsed arrays are empty.
    // This prevents stale active memberships from surviving when Sportlink returns no current rows.
    if (functionsData) {
      db.prepare('DELETE FROM sportlink_member_functions WHERE knvb_id = ?').run(knvbId);
      if (functions.length > 0) {
        upsertMemberFunctions(db, functions);
      }
    }

    if (functionsData) {
      db.prepare('DELETE FROM sportlink_member_committees WHERE knvb_id = ?').run(knvbId);
      if (committees.length > 0) {
        upsertMemberCommittees(db, committees);
      }
    }

    if (freeFieldsData) {
      // Update or insert free fields for this member
      upsertMemberFreeFields(db, [freeFieldsData]);
    }

    return {
      success: true,
      memberData,
      functions,
      committees,
      freeFields: freeFieldsData,
      teamMemberships
    };

  } finally {
    await browser.close();
    log('Browser closed');
  }
}

/**
 * Sync functions/commissie work history for a single member
 */
async function syncFunctionsForMember(knvbId, rondoClubId, db, memberFunctions, memberCommittees, options = {}) {
  const { verbose = false, force = false } = options;
  const log = verbose ? console.log : () => {};

  // Build commissie map
  const commissies = getAllCommissies(db);
  const commissieMap = new Map(commissies.map(c => [c.commissie_name, c.rondo_club_id]));

  if (commissies.length === 0) {
    log('No commissies found in database. Run functions sync first.');
    return { synced: false, added: 0, ended: 0 };
  }

  // Build current commissies list from functions and committees
  const currentCommissies = [];

  // Functions go to "Verenigingsbreed"
  for (const func of memberFunctions) {
    currentCommissies.push({
      commissie_name: 'Verenigingsbreed',
      role_name: func.function_description,
      is_active: func.is_active === 1,
      relation_start: func.relation_start,
      relation_end: func.relation_end
    });
  }

  // Committees go to their respective commissie
  for (const comm of memberCommittees) {
    currentCommissies.push({
      commissie_name: comm.committee_name,
      role_name: comm.role_name,
      is_active: comm.is_active === 1,
      relation_start: comm.relation_start,
      relation_end: comm.relation_end
    });
  }

  if (currentCommissies.length === 0) {
    log('No current functions or committees found; syncing to end previously tracked memberships if needed');
  }

  log(`Syncing ${currentCommissies.length} function(s)/committee(s) for ${knvbId}`);

  try {
    const result = await syncCommissieWorkHistoryForMember(
      { knvb_id: knvbId, rondo_club_id: rondoClubId },
      currentCommissies,
      db,
      commissieMap,
      { verbose },
      force
    );

    return {
      synced: result.action === 'updated',
      added: result.added || 0,
      ended: result.ended || 0
    };
  } catch (error) {
    console.error(`Error syncing functions for ${knvbId}: ${error.message}`);
    return { synced: false, added: 0, ended: 0, error: error.message };
  }
}

/**
 * Sync parent records linked to a specific member KNVB ID.
 * This keeps parent/sibling links fresh during individual member sync.
 */
async function syncParentsForMember(knvbId, db, options = {}) {
  const { verbose = false } = options;
  const log = verbose ? console.log : () => {};

  const prepared = await runPrepareParents({ verbose });
  if (!prepared.success) {
    return { synced: 0, created: 0, updated: 0, total: 0, errors: [{ message: prepared.error || 'Prepare parents failed' }] };
  }

  upsertParents(db, prepared.parents);
  const allParents = getParentsNeedingSync(db, true);
  const memberParents = allParents.filter(parent => Array.isArray(parent.childKnvbIds) && parent.childKnvbIds.includes(knvbId));

  if (memberParents.length === 0) {
    return { synced: 0, created: 0, updated: 0, total: 0, errors: [] };
  }

  const rows = db.prepare('SELECT knvb_id, rondo_club_id FROM rondo_club_members WHERE rondo_club_id IS NOT NULL').all();
  const knvbIdToRondoClubId = new Map(rows.map(row => [row.knvb_id, row.rondo_club_id]));

  const result = { synced: 0, created: 0, updated: 0, total: memberParents.length, errors: [] };

  for (const parent of memberParents) {
    try {
      const syncResult = await syncParent(parent, db, knvbIdToRondoClubId, { verbose });
      result.synced++;
      if (syncResult.action === 'created') result.created++;
      if (syncResult.action === 'updated') result.updated++;
    } catch (error) {
      result.errors.push({ email: parent.email, message: error.message });
    }
  }

  if (result.synced > 0) {
    log(`Parents: ${result.synced}/${result.total} synced (${result.created} created, ${result.updated} updated)`);
  }

  return result;
}

/**
 * Sync a single person by KNVB ID
 */
async function syncIndividual(knvbId, options = {}) {
  const { verbose = false, force = true, dryRun = false, skipFunctions = false, fetch = false } = options;
  const log = verbose ? console.log : () => {};

  // Open databases
  const lapostaDb = openLapostaDb();
  const rondoClubDb = openRondoClubDb();

  try {
    // Fetch fresh data from Sportlink if requested
    let freshMemberData = null;
    let freshTeamMemberships = null;
    if (fetch) {
      console.log('Fetching fresh data from Sportlink...');
      const fetchResult = await fetchFreshDataFromSportlink(knvbId, rondoClubDb, { verbose });
      if (!fetchResult.success) {
        console.error('Failed to fetch data from Sportlink');
        return { success: false, error: 'Failed to fetch from Sportlink' };
      }
      freshMemberData = fetchResult.memberData;
      freshTeamMemberships = Array.isArray(fetchResult.teamMemberships) ? fetchResult.teamMemberships : null;
      console.log('Fresh data fetched successfully');
    }

    // Use fresh member data from /general if available, otherwise fall back to bulk download
    let member;
    if (freshMemberData) {
      member = freshMemberData;
      log(`Using fresh data: ${member.FirstName} ${member.Infix || ''} ${member.LastName}`);
    } else {
      const resultsJson = getLatestSportlinkResults(lapostaDb);
      if (!resultsJson) {
        console.error('No Sportlink data found. Run download-data-from-sportlink.js first.');
        return { success: false, error: 'No Sportlink data' };
      }

      const data = JSON.parse(resultsJson);
      const members = data.Members || data;
      log(`Found ${members.length} members in Sportlink data`);

      member = members.find(m => m.PublicPersonId === knvbId);
      if (!member) {
        console.error(`Member with KNVB ID "${knvbId}" not found in Sportlink data`);
        return { success: false, error: 'Member not found' };
      }

      log(`Found member: ${member.FirstName} ${member.Infix || ''} ${member.LastName}`);
    }

    // Get free fields for this member (now includes freshly fetched data if --fetch was used)
    const freeFields = getMemberFreeFieldsByKnvbId(rondoClubDb, knvbId);
    const freeFieldMappings = getFreeFieldMappings(rondoClubDb);
    log(`Free fields: ${JSON.stringify(freeFields)}`);

    // Prepare the person data
    const prepared = preparePerson(member, freeFields, null, freeFieldMappings);
    log(`Prepared data for ${prepared.knvb_id}`);

    // Upsert to tracking database to get current state
    upsertMembers(rondoClubDb, [prepared]);

    // Get rondo_club_id from database
    const stmt = rondoClubDb.prepare('SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?');
    const row = stmt.get(knvbId);
    const rondoClubId = row?.rondo_club_id;

    log(`Rondo Club ID: ${rondoClubId || 'none (will create)'}`);

    // Get functions data for dry run display
    const memberFunctions = getMemberFunctions(rondoClubDb, knvbId);
    const memberCommittees = getMemberCommittees(rondoClubDb, knvbId);

    if (dryRun) {
      console.log('\n=== DRY RUN - No changes will be made ===');
      console.log(`KNVB ID: ${knvbId}`);
      console.log(`Rondo Club ID: ${rondoClubId || '(will create new)'}`);
      console.log(`Name: ${prepared.data.acf.first_name} ${prepared.data.acf.last_name}`);
      console.log(`Email: ${prepared.email || 'none'}`);
      console.log('\nData to sync:');
      console.log(JSON.stringify(prepared.data, null, 2));

      if (!skipFunctions) {
        console.log('\nFunctions (Verenigingsbreed):');
        if (memberFunctions.length === 0) {
          console.log('  (none)');
        } else {
          memberFunctions.forEach(f => {
            console.log(`  - ${f.function_description} (${f.is_active ? 'active' : 'inactive'})`);
          });
        }

        console.log('\nCommittee memberships:');
        if (memberCommittees.length === 0) {
          console.log('  (none)');
        } else {
          memberCommittees.forEach(c => {
            console.log(`  - ${c.committee_name}: ${c.role_name || '(no role)'} (${c.is_active ? 'active' : 'inactive'})`);
          });
        }
      }
      return { success: true, action: 'dry-run' };
    }

    // Perform the sync
    if (rondoClubId) {
      // UPDATE existing person
      log(`Updating existing person: ${rondoClubId}`);

      // Get existing person for conflict resolution
      let existingData = null;
      try {
        const existing = await rondoClubRequest(`wp/v2/people/${rondoClubId}`, 'GET', null, { verbose });
        existingData = existing.body;
      } catch (e) {
        if (e.message?.includes('404')) {
          console.log(`Person ${rondoClubId} no longer exists in Rondo Club - will create new`);
          // Fall through to create
        } else {
          throw e;
        }
      }

      if (existingData) {
        // Resolve conflicts
        let updateData = prepared.data;
        const sportlinkData = extractTrackedFieldValues(prepared.data);
        const rondoClubData = extractTrackedFieldValues(existingData);

        const resolution = resolveFieldConflicts(
          { knvb_id: knvbId, source_hash: prepared.source_hash },
          sportlinkData,
          rondoClubData,
          rondoClubDb
        );

        if (resolution.conflicts.length > 0) {
          console.log(`Resolved ${resolution.conflicts.length} conflict(s):`);
          resolution.conflicts.forEach(c => {
            console.log(`  - ${c.field}: ${c.winner} wins (${c.reason})`);
          });
          updateData = applyResolutions(prepared.data, resolution.resolutions);
        }

        // Preserve existing addresses if Sportlink has no address data
        // This prevents individual sync from clearing addresses when Sportlink data is incomplete
        if (updateData.acf.addresses && updateData.acf.addresses.length === 0 &&
            existingData.acf && existingData.acf.addresses && existingData.acf.addresses.length > 0) {
          log('Preserving existing addresses (Sportlink has no address data)');
          updateData.acf.addresses = existingData.acf.addresses;
        }

        await rondoClubRequest(`wp/v2/people/${rondoClubId}`, 'PUT', updateData, { verbose });
        updateSyncState(rondoClubDb, knvbId, prepared.source_hash, rondoClubId);

        console.log(`Updated person ${rondoClubId} (${prepared.data.acf.first_name} ${prepared.data.acf.last_name})`);

        // Sync functions/commissie work history
        if (!skipFunctions) {
          const functionsResult = await syncFunctionsForMember(knvbId, rondoClubId, rondoClubDb, memberFunctions, memberCommittees, { verbose, force });
          if (functionsResult.synced) {
            console.log(`  Functions: ${functionsResult.added} added, ${functionsResult.ended} ended`);
          }
        }

        // Also sync linked parents so family relationships stay current.
        const parentResult = await syncParentsForMember(knvbId, rondoClubDb, { verbose });
        if (parentResult.errors.length > 0) {
          console.log(`  Parent sync errors: ${parentResult.errors.length}`);
          parentResult.errors.forEach(e => console.log(`    - ${e.email || 'unknown'}: ${e.message}`));
        }

        const playerHistoryResult = freshTeamMemberships
          ? await syncSinglePlayerHistory({
            db: rondoClubDb,
            knvbId,
            rondoClubId,
            teamRows: freshTeamMemberships,
            verbose
          })
          : await runPlayerHistorySync({ verbose, knvbIds: [knvbId] });
        if (playerHistoryResult.errors.length > 0) {
          console.log(`  Player history sync errors: ${playerHistoryResult.errors.length}`);
          playerHistoryResult.errors.forEach(e => console.log(`    - ${e.knvb_id || knvbId}: ${e.message}`));
        } else if (playerHistoryResult.created > 0) {
          console.log(`  Player history: ${playerHistoryResult.created} work history row(s) added`);
        }

        return { success: true, action: 'updated', rondoClubId };
      }
    }

    // CREATE new person
    log('Creating new person');
    const response = await rondoClubRequest('wp/v2/people', 'POST', prepared.data, { verbose });
    const newId = response.body.id;
    updateSyncState(rondoClubDb, knvbId, prepared.source_hash, newId);

    console.log(`Created person ${newId} (${prepared.data.acf.first_name} ${prepared.data.acf.last_name})`);

    // Sync functions/commissie work history for new person
    if (!skipFunctions) {
      const functionsResult = await syncFunctionsForMember(knvbId, newId, rondoClubDb, memberFunctions, memberCommittees, { verbose, force });
      if (functionsResult.synced) {
        console.log(`  Functions: ${functionsResult.added} added, ${functionsResult.ended} ended`);
      }
    }

    // Also sync linked parents so family relationships stay current.
    const parentResult = await syncParentsForMember(knvbId, rondoClubDb, { verbose });
    if (parentResult.errors.length > 0) {
      console.log(`  Parent sync errors: ${parentResult.errors.length}`);
      parentResult.errors.forEach(e => console.log(`    - ${e.email || 'unknown'}: ${e.message}`));
    }

    const playerHistoryResult = freshTeamMemberships
      ? await syncSinglePlayerHistory({
        db: rondoClubDb,
        knvbId,
        rondoClubId: newId,
        teamRows: freshTeamMemberships,
        verbose
      })
      : await runPlayerHistorySync({ verbose, knvbIds: [knvbId] });
    if (playerHistoryResult.errors.length > 0) {
      console.log(`  Player history sync errors: ${playerHistoryResult.errors.length}`);
      playerHistoryResult.errors.forEach(e => console.log(`    - ${e.knvb_id || knvbId}: ${e.message}`));
    } else if (playerHistoryResult.created > 0) {
      console.log(`  Player history: ${playerHistoryResult.created} work history row(s) added`);
    }

    return { success: true, action: 'created', rondoClubId: newId };

  } finally {
    lapostaDb.close();
    rondoClubDb.close();
  }
}

/**
 * Look up a member by name (partial match)
 */
function findMemberByName(searchTerm) {
  const lapostaDb = openLapostaDb();
  try {
    const resultsJson = getLatestSportlinkResults(lapostaDb);
    if (!resultsJson) return [];

    const data = JSON.parse(resultsJson);
    const members = data.Members || data;
    const search = searchTerm.toLowerCase();

    return members.filter(m => {
      const fullName = `${m.FirstName} ${m.Infix || ''} ${m.LastName}`.toLowerCase();
      return fullName.includes(search);
    }).map(m => ({
      knvbId: m.PublicPersonId,
      name: `${m.FirstName} ${m.Infix ? m.Infix + ' ' : ''}${m.LastName}`,
      email: m.Email
    }));
  } finally {
    lapostaDb.close();
  }
}

module.exports = { syncIndividual, findMemberByName };

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const force = true;
  const dryRun = args.includes('--dry-run');
  const searchMode = args.includes('--search');
  const skipFunctions = args.includes('--skip-functions');
  const fetch = args.includes('--fetch');

  // Filter out flags to get the identifier
  const identifier = args.find(a => !a.startsWith('--'));

  if (!identifier) {
    console.log('Usage: node sync-individual.js <knvb-id> [options]');
    console.log('       node sync-individual.js --search <name> [options]');
    console.log('\nOptions:');
    console.log('  --verbose         Show detailed output');
    console.log('  --force           (legacy) no-op; sync is always forced');
    console.log('  --dry-run         Show what would be synced without making changes');
    console.log('  --search          Search for members by name');
    console.log('  --skip-functions  Skip syncing functions/commissie work history');
    console.log('  --fetch           Fetch fresh data from Sportlink (functions, VOG, etc.)');
    console.log('\nExamples:');
    console.log('  node sync-individual.js 12345678          # Sync by KNVB ID');
    console.log('  node sync-individual.js 12345678 --fetch  # Fetch fresh data from Sportlink first');
    console.log('  node sync-individual.js --search Jan      # Find members named Jan');
    process.exit(1);
  }

  if (searchMode) {
    const results = findMemberByName(identifier);
    if (results.length === 0) {
      console.log(`No members found matching "${identifier}"`);
    } else {
      console.log(`Found ${results.length} member(s):\n`);
      results.forEach(m => {
        console.log(`  ${m.knvbId}  ${m.name}  ${m.email || '(no email)'}`);
      });
    }
    process.exit(0);
  }

  syncIndividual(identifier, { verbose, force, dryRun, skipFunctions, fetch })
    .then(result => {
      if (!result.success) {
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      if (verbose) console.error(err.stack);
      process.exitCode = 1;
    });
}
