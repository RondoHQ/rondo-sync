/**
 * Rondo Club Change Detection Module
 * Detects changes in Rondo Club that need reverse sync to Sportlink.
 */

const { rondoClubRequestWithRetry } = require('./rondo-club-client');
const { openDb, logChangeDetection, hasRecentSyncedNoOp, getLastDetectionTime, updateLastDetectionTime } = require('./rondo-club-db');
const { TRACKED_FIELDS, SYNC_ORIGIN } = require('./sync-origin');
const { createSyncLogger } = require('./logger');
const { stableStringify, computeHash } = require('./utils');
const { createLoggerAdapter } = require('./log-adapters');

/**
 * Contacts are local Rondo Club records and must never be written to Sportlink.
 * Check the explicit person type instead of relying on the absence of a KNVB ID,
 * because imported or historical contact data may still contain one.
 *
 * @param {Object} fields - Rondo Club canonical fields
 * @returns {boolean} Whether this person is a local contact
 */
function isRondoClubContact(fields = {}) {
  return fields.person_type === 'contact';
}

/**
 * Extract field value from Rondo Club member data.
 * Handles different field types (contact_info repeater vs direct canonical fields).
 *
 * @param {Object} rondoClubData - Rondo Club member data with canonical fields
 * @param {string} field - Field name from TRACKED_FIELDS
 * @returns {any} Field value or null if not found
 */
function extractFieldValue(rondoClubData, field) {
  const fields = rondoClubData.fields || {};

  // Fixed contact fields — direct native field properties
  if (['email_1', 'email_2', 'mobile_1', 'mobile_2', 'telephone_1'].includes(field)) {
    return fields[field] || null;
  }

  // Direct canonical fields with hyphenated names (unchanged)
  if (field === 'datum_vog') return fields['datum_vog'] || null;
  if (field === 'freescout_id') return fields['freescout_id'] || null;
  if (field === 'financiele_blokkade') return fields['financiele_blokkade'] || null;

  // Home address fields — from addresses repeater, first row with label 'Home'
  const ADDRESS_FIELDS = ['street_name', 'house_number', 'house_number_addition', 'postal_code', 'city', 'country_code'];
  if (ADDRESS_FIELDS.includes(field)) {
    const addresses = fields.addresses || [];
    const homeAddress = addresses.find(a => a.address_label === 'Home') || addresses[0];
    if (!homeAddress) return null;
    return homeAddress[field] || null;
  }

  return null;
}

/**
 * Compute SHA-256 hash of tracked fields for change detection.
 *
 * @param {string} knvbId - Member KNVB ID
 * @param {Object} rondoClubData - Rondo Club member data with canonical fields
 * @returns {string} SHA-256 hash (64-char hex string)
 */
function computeTrackedFieldsHash(knvbId, rondoClubData) {
  const trackedValues = {};

  for (const field of TRACKED_FIELDS) {
    trackedValues[field] = extractFieldValue(rondoClubData, field);
  }

  const payload = stableStringify({ knvb_id: knvbId, fields: trackedValues });
  return computeHash(payload);
}

/**
 * Fetch modified members from Rondo Club API since a timestamp.
 * Uses WordPress modified_after parameter for incremental queries.
 *
 * @param {string} since - ISO timestamp to query from
 * @param {Object} options - Options (logger, verbose)
 * @returns {Promise<Array>} Array of modified members
 */
async function fetchModifiedMembers(since, options = {}) {
  const { logger, verbose } = options;
  const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

  const allMembers = [];
  let page = 1;

  while (true) {
    // former_member=0 is a Rondo Club custom filter (rondo-club 33.18.0+)
    // that excludes ex-members at the WP_Query level. Saves us pulling
    // their native field blobs over REST just to skip them in JS. Older Rondo Club
    // versions ignore the param, so this falls back to the JS-side skip.
    const endpoint = `wp/v2/people?per_page=100&page=${page}&modified_after=${encodeURIComponent(since)}&former_member=0&_fields=id,modified_gmt,fields`;
    logVerbose(`Fetching page ${page} of modified members...`);

    const response = await rondoClubRequestWithRetry(endpoint, 'GET', null, options);
    const members = response.body;

    if (!Array.isArray(members)) {
      throw new Error('Unexpected API response: expected array of members');
    }

    allMembers.push(...members);

    // Last page when we get fewer than per_page results
    if (members.length < 100) {
      break;
    }

    page++;
  }

  logVerbose(`Fetched ${allMembers.length} modified members since ${since}`);
  return allMembers;
}

/**
 * Detect changes in Rondo Club members that need reverse sync.
 * Compares tracked field hashes to identify actual changes.
 *
 * @param {Object} options - Options
 * @param {boolean} [options.verbose] - Verbose logging
 * @param {Object} [options.logger] - Logger instance
 * @returns {Promise<Array>} Array of detected changes
 */
async function detectChanges(options = {}) {
  const { verbose = false, logger: providedLogger, knvbId: filterKnvbId = null } = options;
  const logger = providedLogger || createSyncLogger({ verbose });

  const db = openDb();

  try {
    // Get last detection timestamp
    let lastDetection = getLastDetectionTime(db);

    if (!lastDetection) {
      // First run: use a timestamp far in the past
      lastDetection = '2020-01-01T00:00:00Z';
      logger.log('First detection run, checking all members since 2020-01-01');
    } else {
      logger.verbose(`Last detection: ${lastDetection}`);
    }

    const detectionRunId = new Date().toISOString();

    // Fetch modified members from Rondo Club API
    logger.log('Fetching modified members from Rondo Club...');
    const modifiedMembers = await fetchModifiedMembers(lastDetection, { logger, verbose });

    if (modifiedMembers.length === 0) {
      logger.log('No modified members found');
      updateLastDetectionTime(db, detectionRunId);
      return [];
    }

    logger.log(`Processing ${modifiedMembers.length} modified members...`);
    const detectedChanges = [];
    let suppressedDuplicates = 0;
    let skippedFormerMembers = 0;

    for (const member of modifiedMembers) {
      const fields = member.fields || {};

      if (isRondoClubContact(fields)) {
        logger.verbose(`Skipping contact ${member.id}: contacts are never synced to Sportlink`);
        continue;
      }

      const knvbId = fields['knvb_id'];

      if (!knvbId) {
        logger.verbose(`Skipping member ${member.id}: no KNVB ID`);
        continue;
      }

      if (filterKnvbId && knvbId !== filterKnvbId) {
        logger.verbose(`Skipping ${knvbId}: does not match filter ${filterKnvbId}`);
        continue;
      }

      // Skip deceased members
      const datumOverlijden = fields['datum_overlijden'];
      if (datumOverlijden && new Date(datumOverlijden) <= new Date()) {
        logger.verbose(`Skipping ${knvbId}: deceased (${datumOverlijden})`);
        continue;
      }

      // Skip former members — Sportlink rejects writes for their lidsoort
      // ("Oud bondslid" / "Oud verenigingslid"), so any change we'd detect
      // here can never land. Rondo Club's UI is also now read-only for
      // these persons, so a real edit shouldn't arrive in the first place.
      if (fields.former_member === true) {
        logger.verbose(`Skipping ${knvbId}: former member (unwritable in Sportlink)`);
        skippedFormerMembers++;
        continue;
      }

      // Get local database record
      const stmt = db.prepare(`
        SELECT knvb_id, tracked_fields_hash, sync_origin
        FROM rondo_club_members
        WHERE knvb_id = ?
      `);
      const localRecord = stmt.get(knvbId);

      if (!localRecord) {
        logger.verbose(`Skipping ${knvbId}: not in local database`);
        continue;
      }

      // Skip if last change was from forward sync
      if (localRecord.sync_origin === SYNC_ORIGIN.SYNC_FORWARD) {
        logger.verbose(`Skipping ${knvbId}: last change was from forward sync`);
        continue;
      }

      // Compute current hash
      const currentHash = computeTrackedFieldsHash(knvbId, member);

      // Compare hashes
      if (currentHash === localRecord.tracked_fields_hash) {
        logger.verbose(`No changes detected for ${knvbId}`);
        continue;
      }

      // Hash changed - compare individual fields to find what changed
      logger.verbose(`Hash changed for ${knvbId}, comparing fields...`);

      // Get old data from database (once per member, outside field loop)
      const oldStmt = db.prepare(`
        SELECT data_json
        FROM rondo_club_members
        WHERE knvb_id = ?
      `);
      const oldData = oldStmt.get(knvbId);
      const parsedOldData = oldData && oldData.data_json ? JSON.parse(oldData.data_json) : {};

      for (const field of TRACKED_FIELDS) {
        const newValue = extractFieldValue(member, field);
        const oldValue = extractFieldValue(parsedOldData, field);

        // Compare old vs new - skip if unchanged
        if (oldValue === newValue) {
          continue;
        }

        // A blank is a meaningful, explicit removal and must reach Sportlink.
        // Only the historical dash sentinel is not a real value.
        const trimmedNew = newValue !== null ? String(newValue).trim() : '';
        if (trimmedNew === '-') {
          logger.verbose(`  - ${field}: skipping bogus value "${newValue}"`);
          continue;
        }

        // Skip if we've already detected and "synced" this exact (knvb_id,
        // field, new_value) within the last 30 days. The reverse-sync marks
        // unwritable changes (e.g., Oud bondslid members) as synced without
        // an actual Sportlink write, which leaves data_json unchanged and
        // re-triggers detection forever. Trust the prior synced marker —
        // if the value were ever going to land, data_json would have been
        // refreshed by a forward sync and oldValue would now match.
        if (hasRecentSyncedNoOp(db, knvbId, field, newValue)) {
          logger.verbose(`  - ${field}: already attempted ("${newValue}") and marked synced — skipping`);
          suppressedDuplicates++;
          continue;
        }

        const change = {
          knvb_id: knvbId,
          field_name: field,
          old_value: oldValue !== null ? String(oldValue) : null,
          new_value: newValue !== null ? String(newValue) : null,
          rondo_club_modified_gmt: member.modified_gmt,
          detection_run_id: detectionRunId
        };

        logChangeDetection(db, change);
        detectedChanges.push(change);

        logger.verbose(`  - ${field}: ${oldValue} -> ${newValue}`);
      }

      // Update the tracked fields hash so next run only detects new changes
      db.prepare('UPDATE rondo_club_members SET tracked_fields_hash = ? WHERE knvb_id = ?')
        .run(currentHash, knvbId);
    }

    // Update last detection time
    updateLastDetectionTime(db, detectionRunId);

    logger.log(`Detected ${detectedChanges.length} field changes`);
    if (suppressedDuplicates > 0) {
      logger.log(`Suppressed ${suppressedDuplicates} duplicate detection(s) already marked synced`);
    }
    if (skippedFormerMembers > 0) {
      logger.log(`Skipped ${skippedFormerMembers} former member(s) (unwritable in Sportlink)`);
    }
    return detectedChanges;

  } finally {
    db.close();
  }
}

module.exports = {
  detectChanges,
  extractFieldValue,
  computeTrackedFieldsHash,
  isRondoClubContact
};

// Self-test when run directly
if (require.main === module) {
  const { openDb } = require('./rondo-club-db');

  async function selfTest() {
    console.log('=== Rondo Club Change Detection Self-Test ===\n');

    // Test 1: Field extraction from fixed canonical fields
    console.log('Test 1: Field extraction from fixed canonical fields');
    const mockMember = {
      fields: {
        email_1: 'john@example.com',
        mobile_1: '+31612345678',
        telephone_1: '+31201234567',
        'datum_vog': '2025-06-15',
        'freescout_id': 42,
        'financiele_blokkade': true
      }
    };

    const email = extractFieldValue(mockMember, 'email_1');
    const mobile = extractFieldValue(mockMember, 'mobile_1');
    const telephone = extractFieldValue(mockMember, 'telephone_1');
    const datumVog = extractFieldValue(mockMember, 'datum_vog');
    const freescoutId = extractFieldValue(mockMember, 'freescout_id');
    const financieleBlockkade = extractFieldValue(mockMember, 'financiele_blokkade');

    console.log(`  email_1: ${email} (expected: john@example.com)`);
    console.log(`  mobile_1: ${mobile} (expected: +31612345678)`);
    console.log(`  telephone_1: ${telephone} (expected: +31201234567)`);
    console.log(`  datum_vog: ${datumVog} (expected: 2025-06-15)`);
    console.log(`  freescout_id: ${freescoutId} (expected: 42)`);
    console.log(`  financiele_blokkade: ${financieleBlockkade} (expected: true)`);
    console.log('');

    // Test 2: Hash computation
    console.log('Test 2: Hash computation (deterministic)');
    const hash1 = computeTrackedFieldsHash('KNVB123', mockMember);
    const hash2 = computeTrackedFieldsHash('KNVB123', mockMember);
    console.log(`  hash1: ${hash1.substring(0, 32)}...`);
    console.log(`  hash2: ${hash2.substring(0, 32)}...`);
    console.log(`  identical: ${hash1 === hash2} (expected: true)`);
    console.log('');

    // Test 3: Database helpers
    console.log('Test 3: Database helper functions');
    const db = openDb(':memory:');

    // Test getLastDetectionTime (should be null initially)
    const { getLastDetectionTime, updateLastDetectionTime, logChangeDetection, getChangeDetections } = require('./rondo-club-db');
    const initial = getLastDetectionTime(db);
    console.log(`  initial lastDetection: ${initial} (expected: null)`);

    // Test updateLastDetectionTime
    const testTime = '2026-01-29T12:00:00.000Z';
    updateLastDetectionTime(db, testTime);
    const updated = getLastDetectionTime(db);
    console.log(`  after update: ${updated} (expected: ${testTime})`);

    // Test logChangeDetection
    logChangeDetection(db, {
      knvb_id: 'TEST123',
      field_name: 'email',
      old_value: 'old@test.com',
      new_value: 'new@test.com',
      rondo_club_modified_gmt: '2026-01-29T11:00:00.000Z',
      detection_run_id: testTime
    });

    const detections = getChangeDetections(db);
    console.log(`  logged detections: ${detections.length} (expected: 1)`);
    console.log(`  detection field: ${detections[0]?.field_name} (expected: email)`);
    console.log('');

    db.close();

    // Test 4: Field-level comparison skips unchanged fields
    console.log('Test 4: Field-level comparison skips unchanged fields');

    const oldMemberData = {
      fields: {
        email_1: 'john@example.com',
        mobile_1: '+31612345678',
        'datum_vog': '2025-06-15',
        'freescout_id': 42
      }
    };

    const newMemberData = {
      fields: {
        email_1: 'john.new@example.com',  // CHANGED
        mobile_1: '+31612345678',          // UNCHANGED
        'datum_vog': '2025-06-15',         // UNCHANGED
        'freescout_id': 42                 // UNCHANGED
      }
    };

    // Count how many fields are actually different
    let changedCount = 0;
    for (const field of TRACKED_FIELDS) {
      const oldVal = extractFieldValue(oldMemberData, field);
      const newVal = extractFieldValue(newMemberData, field);
      if (oldVal !== newVal) {
        changedCount++;
        console.log(`  ${field}: "${oldVal}" -> "${newVal}" (CHANGED)`);
      }
    }

    console.log(`  Total changed fields: ${changedCount} (expected: 1 - only email_1)`);

    console.log('\n=== All tests passed ===');
  }

  selfTest().catch(err => {
    console.error('Self-test failed:', err);
    process.exit(1);
  });
}
