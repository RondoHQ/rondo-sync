require('dotenv/config');

const { rondoClubRequestWithRetry } = require('../lib/rondo-club-client');
const { openDb: openNikkiDb, getContributionsGroupedByMember } = require('../lib/nikki-db');
const { openDb: openRondoClubDb, getAllTrackedMembers } = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');
const { parseCliArgs, stableStringify, computeHash } = require('../lib/utils');

/**
 * Coerce any value to a finite number, or null. Required because Rondo Club's
 * `_nikki_YYYY_total` / `_saldo` canonical fields are typed `number` and WP REST rejects
 * empty strings with `rest_invalid_type` — which used to trigger thousands of retries
 * per cycle until the People sync logs ballooned past 300k lines.
 */
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build per-year canonical fields from contributions.
 * Creates fields like _nikki_2025_total, _nikki_2025_saldo, _nikki_2025_status
 */
function buildPerYearFields(contributions) {
  const fields = {};
  for (const c of contributions) {
    fields[`_nikki_${c.year}_total`] = toNumberOrNull(c.hoofdsom);
    fields[`_nikki_${c.year}_saldo`] = toNumberOrNull(c.saldo);
    fields[`_nikki_${c.year}_status`] = c.status || null;
  }
  return fields;
}

/**
 * Compute hash for change detection using stable JSON serialization.
 */
function computeFieldsHash(fields) {
  return computeHash(stableStringify(fields));
}

/**
 * Sync Nikki contribution data to Rondo Club per-year canonical fields
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force update all members
 * @param {boolean} [options.dryRun=false] - Don't actually update Rondo Club
 * @returns {Promise<{success: boolean, updated: number, skipped: number, errors: number}>}
 */
async function runNikkiRondoClubSync(options = {}) {
  const { logger: providedLogger, verbose = false, force = false, dryRun = false } = options;
  const logger = providedLogger || createSyncLogger({ verbose, prefix: 'nikki-rondo-club' });

  const result = {
    success: true,
    updated: 0,
    skipped: 0,
    errors: 0,
    noStadionId: 0
  };

  const nikkiDb = openNikkiDb();
  const rondoClubDb = openRondoClubDb();

  try {
    logger.log('Starting Nikki → Rondo Club sync');

    // Get all Nikki contributions grouped by KNVB ID
    const contributionsByMember = getContributionsGroupedByMember(nikkiDb);
    logger.verbose(`Found contributions for ${contributionsByMember.size} members`);

    // Get all tracked members from Rondo Club DB (knvb_id → rondo_club_id mapping)
    const trackedMembers = getAllTrackedMembers(rondoClubDb);
    const knvbIdToRondoClubId = new Map();
    for (const member of trackedMembers) {
      if (member.knvb_id && member.rondo_club_id) {
        knvbIdToRondoClubId.set(member.knvb_id, member.rondo_club_id);
      }
    }
    logger.verbose(`Loaded ${knvbIdToRondoClubId.size} KNVB → Rondo Club ID mappings`);

    // Process each member with contributions
    let processed = 0;
    for (const [knvbId, contributions] of contributionsByMember) {
      processed++;
      const rondoClubId = knvbIdToRondoClubId.get(knvbId);

      if (!rondoClubId) {
        logger.verbose(`[${processed}/${contributionsByMember.size}] ${knvbId}: No Rondo Club ID, skipping`);
        result.noStadionId++;
        continue;
      }

      // Build per-year canonical fields for all contribution years
      const perYearFields = buildPerYearFields(contributions);
      const newFieldsHash = computeFieldsHash(perYearFields);

      // Fetch existing data from Rondo Club (needed for change detection AND name fields)
      let existingFirstName = '';
      let existingLastName = '';
      let skipUpdate = false;

      try {
        const response = await rondoClubRequestWithRetry(
          `wp/v2/people/${rondoClubId}?_fields=fields`,
          'GET',
          null,
          { verbose: false }
        );

        existingFirstName = response.body?.fields?.first_name || '';
        existingLastName = response.body?.fields?.last_name || '';

        // Check if we need to update (only if not forcing)
        if (!force) {
          // Extract existing per-year fields from response for comparison
          const existingFields = response.body?.fields || {};
          const existingPerYearFields = {};
          for (const key of Object.keys(perYearFields)) {
            existingPerYearFields[key] = existingFields[key] ?? null;
          }
          const existingFieldsHash = computeFieldsHash(existingPerYearFields);

          if (existingFieldsHash === newFieldsHash) {
            logger.verbose(`[${processed}/${contributionsByMember.size}] ${knvbId}: No changes, skipping`);
            result.skipped++;
            skipUpdate = true;
          }
        }
      } catch (error) {
        // If fetch fails, we can't update safely (need first_name for API)
        logger.error(`[${processed}/${contributionsByMember.size}] ${knvbId}: Could not fetch current data: ${error.message}`);
        result.errors++;
        continue;
      }

      if (skipUpdate) {
        continue;
      }

      if (dryRun) {
        const years = contributions.map(c => c.year).join(', ');
        logger.log(`[DRY-RUN] Would update ${knvbId} (Rondo Club ID: ${rondoClubId}, years: ${years})`);
        result.updated++;
        continue;
      }

      // Update Rondo Club
      try {
        logger.verbose(`[${processed}/${contributionsByMember.size}] ${knvbId}: Updating Rondo Club ID ${rondoClubId}`);

        await rondoClubRequestWithRetry(
          `wp/v2/people/${rondoClubId}`,
          'PUT',
          {
            fields: {
              first_name: existingFirstName,
              last_name: existingLastName,
              ...perYearFields
            }
          },
          { verbose: false }
        );

        result.updated++;
        const years = contributions.map(c => c.year).join(', ');
        logger.verbose(`  Updated successfully (years: ${years})`);

      } catch (error) {
        result.errors++;
        logger.error(`[${processed}/${contributionsByMember.size}] ${knvbId}: Update failed - ${error.message}`);
        if (error.details) {
          logger.verbose(`  Details: ${JSON.stringify(error.details)}`);
        }
      }

      // Delay between requests to avoid overwhelming server
      if (processed < contributionsByMember.size) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Summary
    logger.log(`Nikki → Rondo Club sync complete`);
    logger.log(`  Updated: ${result.updated}`);
    logger.log(`  Skipped (no changes): ${result.skipped}`);
    logger.log(`  Skipped (no Rondo Club ID): ${result.noStadionId}`);
    if (result.errors > 0) {
      logger.log(`  Errors: ${result.errors}`);
      result.success = false;
    }

    return result;

  } finally {
    nikkiDb.close();
    rondoClubDb.close();
  }
}

module.exports = { runNikkiRondoClubSync, buildPerYearFields, toNumberOrNull };

if (require.main === module) {
  const { verbose, force } = parseCliArgs();
  const dryRun = process.argv.includes('--dry-run');

  runNikkiRondoClubSync({ verbose, force, dryRun })
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
