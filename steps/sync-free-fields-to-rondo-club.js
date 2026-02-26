require('dotenv/config');

const { openDb } = require('../lib/rondo-club-db');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { createSyncLogger } = require('../lib/logger');

function normalizeDate(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  if (/^\d{2}-\d{2}-\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('-');
    return `${year}-${month}-${day}`;
  }
  return trimmed;
}

function convertMappedValue(value, valueType) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (valueType === 'number') {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (valueType === 'date') {
    return normalizeDate(raw);
  }
  if (valueType === 'boolean') {
    const normalized = raw.toLowerCase();
    if (['1', 'true', 'yes', 'ja', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'nee', 'n'].includes(normalized)) return false;
    return null;
  }
  return raw;
}

/**
 * Sync configurable free fields (Remarks1..Remarks8) plus financial block from Sportlink to Rondo Club.
 *
 * Mappings are configured in free_field_mappings (source_field -> target_field + value_type).
 * This step applies mapped fields to person ACF payloads and always syncs financiele-blokkade.
 */
async function runSyncFreeFieldsToRondoClub(options = {}) {
  const { logger, verbose = false, force = false } = options;
  const log = logger?.log.bind(logger) || console.log;
  const logVerbose = logger?.verbose.bind(logger) || (verbose ? console.log : () => {});
  const logError = logger?.error.bind(logger) || console.error;

  const result = {
    total: 0,
    synced: 0,
    skipped: 0,
    errors: []
  };

  const db = openDb();
  try {
    // Get all members with free field data from sportlink_member_free_fields table
    const freeFieldsStmt = db.prepare(`
      SELECT
        smff.knvb_id,
        smff.freescout_id,
        smff.vog_datum,
        smff.remark1,
        smff.remark2,
        smff.remark3,
        smff.remark4,
        smff.remark5,
        smff.remark6,
        smff.remark7,
        smff.remark8,
        smff.has_financial_block,
        rcm.rondo_club_id,
        rcm.data_json,
        rcm.freescout_id_sportlink_modified,
        rcm.datum_vog_sportlink_modified,
        rcm.financiele_blokkade_sportlink_modified
      FROM sportlink_member_free_fields smff
      INNER JOIN rondo_club_members rcm ON smff.knvb_id = rcm.knvb_id
      WHERE rcm.rondo_club_id IS NOT NULL
    `);
    const mappingRows = db.prepare(`
      SELECT source_field, target_field, value_type
      FROM free_field_mappings
      WHERE target_field IS NOT NULL AND TRIM(target_field) != ''
      ORDER BY source_field ASC
    `).all();

    const members = freeFieldsStmt.all();
    result.total = members.length;

    if (members.length === 0) {
      log('No free fields to sync');
      return result;
    }

    log(`Processing ${members.length} members with free field data`);

    for (const member of members) {
      const { knvb_id, has_financial_block, rondo_club_id } = member;

      // Parse stored data to get current field values and required fields
      let data;
      try {
        data = JSON.parse(member.data_json || '{}');
      } catch (e) {
        logVerbose(`Skipping ${knvb_id}: invalid data_json`);
        result.skipped++;
        continue;
      }

      const acf = data.acf || {};
      const firstName = acf.first_name;
      const lastName = acf.last_name;

      if (!firstName || !lastName) {
        logVerbose(`Skipping ${knvb_id}: missing first_name or last_name`);
        result.skipped++;
        continue;
      }

      const newFinancialBlock = has_financial_block === 1;
      const currentFinancialBlock = acf['financiele-blokkade'] || false;
      const financialBlockChanged = newFinancialBlock !== currentFinancialBlock;

      const mappedChanges = [];
      for (const mapping of mappingRows) {
        const sourceKey = String(mapping.source_field).toLowerCase().replace('remarks', 'remark');
        const targetField = String(mapping.target_field || '').trim();
        if (!targetField) continue;

        const newValue = convertMappedValue(member[sourceKey], mapping.value_type || 'string');
        const currentValue = (acf[targetField] === undefined || acf[targetField] === '') ? null : acf[targetField];

        if (force || newValue !== currentValue) {
          mappedChanges.push({ targetField, currentValue, newValue });
        }
      }

      if (!force && mappedChanges.length === 0 && !financialBlockChanged) {
        logVerbose(`Skipping ${knvb_id}: no changes`);
        result.skipped++;
        continue;
      }

      // Build update payload
      const updatePayload = {
        acf: {
          first_name: firstName,
          last_name: lastName
        }
      };

      for (const change of mappedChanges) {
        updatePayload.acf[change.targetField] = change.newValue;
      }
      if (financialBlockChanged || force) {
        updatePayload.acf['financiele-blokkade'] = newFinancialBlock;
      }

      logVerbose(`Syncing free fields for ${knvb_id} → person ${rondo_club_id}`);
      for (const change of mappedChanges) {
        logVerbose(`  ${change.targetField}: ${change.currentValue} → ${change.newValue}`);
      }
      if (financialBlockChanged) logVerbose(`  Financial block: ${currentFinancialBlock} → ${newFinancialBlock}`);

      try {
        await rondoClubRequest(
          `wp/v2/people/${rondo_club_id}`,
          'PUT',
          updatePayload,
          { logger, verbose }
        );

        // Update tracking timestamps for modified fields
        const now = new Date().toISOString();
        if ((force || mappedChanges.some(c => c.targetField === 'datum-vog'))) {
          db.prepare('UPDATE rondo_club_members SET datum_vog_sportlink_modified = ? WHERE knvb_id = ?')
            .run(now, knvb_id);
        }
        if ((force || mappedChanges.some(c => c.targetField === 'freescout-id'))) {
          db.prepare('UPDATE rondo_club_members SET freescout_id_sportlink_modified = ? WHERE knvb_id = ?')
            .run(now, knvb_id);
        }
        if (financialBlockChanged || force) {
          db.prepare('UPDATE rondo_club_members SET financiele_blokkade_sportlink_modified = ? WHERE knvb_id = ?')
            .run(now, knvb_id);
        }

        result.synced++;
      } catch (err) {
        logError(`Error syncing ${knvb_id} (person ${rondo_club_id}): ${err.message}`);
        result.errors.push({
          knvb_id,
          rondo_club_id,
          message: err.message
        });
      }
    }

    log(`Synced ${result.synced} free field updates to Rondo Club (${result.skipped} skipped, ${result.errors.length} errors)`);
    return result;
  } finally {
    db.close();
  }
}

module.exports = { runSyncFreeFieldsToRondoClub };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');
  const logger = createSyncLogger({ verbose, prefix: 'free-fields' });

  runSyncFreeFieldsToRondoClub({ logger, verbose, force })
    .then(result => {
      logger.log(`Done: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`);
      if (result.errors.length > 0) {
        result.errors.forEach(e => logger.error(`  ${e.knvb_id}: ${e.message}`));
        process.exitCode = 1;
      }
      logger.close();
    })
    .catch(err => {
      logger.error(`Fatal: ${err.message}`);
      logger.close();
      process.exitCode = 1;
    });
}
