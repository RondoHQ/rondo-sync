#!/usr/bin/env node
/**
 * Verify SQLite tracking data against Rondo Club WordPress.
 *
 * Checks for discrepancies between local tracking database and actual
 * Rondo Club data. Identifies:
 * - Invalid rondo_club_ids (IDs that don't exist in WordPress)
 * - Orphan records (exist in Rondo Club but not tracked locally)
 * - Missing mappings (tracked locally but no rondo_club_id)
 *
 * Usage:
 *   node tools/verify-rondo-club-data.js [--fix] [--verbose]
 *
 *   --fix      Attempt to fix discrepancies (nullify invalid IDs)
 *   --verbose  Show detailed output
 */

require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb } = require('../lib/rondo-club-db');

// Configuration
const ENTITIES = {
  members: {
    table: 'rondo_club_members',
    idColumn: 'rondo_club_id',
    keyColumn: 'knvb_id',
    endpoint: 'wp/v2/people',
    acfKeyField: 'knvb_id',
    label: 'Members'
  },
  parents: {
    table: 'rondo_club_parents',
    idColumn: 'rondo_club_id',
    keyColumn: 'email',
    endpoint: 'wp/v2/people',
    acfKeyField: null, // Parents use email lookup
    label: 'Parents'
  },
  teams: {
    table: 'rondo_club_teams',
    idColumn: 'rondo_club_id',
    keyColumn: 'team_name',
    endpoint: 'wp/v2/teams',
    acfKeyField: null, // Teams use title
    label: 'Teams'
  },
  commissies: {
    table: 'rondo_club_commissies',
    idColumn: 'rondo_club_id',
    keyColumn: 'commissie_name',
    endpoint: 'wp/v2/commissies',
    acfKeyField: null, // Commissies use title
    label: 'Commissies'
  }
};

/**
 * Fetch all IDs from a Rondo Club endpoint with pagination.
 * @param {string} endpoint - API endpoint
 * @param {Object} options - Options object
 * @returns {Promise<Set<number>>} - Set of valid IDs
 */
async function fetchAllIds(endpoint, options) {
  const { verbose } = options;
  const validIds = new Set();
  let page = 1;

  while (true) {
    let response;
    try {
      response = await rondoClubRequest(
        `${endpoint}?per_page=100&page=${page}&_fields=id`,
        'GET',
        null,
        { verbose: false }
      );
    } catch (error) {
      // 400 error typically means end of pagination
      if (error.message.includes('400')) {
        break;
      }
      throw error;
    }

    if (!Array.isArray(response.body) || response.body.length === 0) {
      break;
    }

    response.body.forEach(item => validIds.add(item.id));

    if (verbose) {
      process.stdout.write(`\r  Fetched page ${page} (${validIds.size} total)`);
    }

    if (response.body.length < 100) break;
    page++;

    // Safety limit
    if (page > 100) {
      console.warn('\n  Warning: Hit page limit (100 pages)');
      break;
    }
  }

  if (verbose) {
    process.stdout.write('\n');
  }

  return validIds;
}

/**
 * Verify a single entity type.
 * @param {Object} db - Database connection
 * @param {string} entityKey - Entity key from ENTITIES
 * @param {Object} options - Options object
 * @returns {Promise<Object>} - Verification results
 */
async function verifyEntity(db, entityKey, options) {
  const { verbose, fix } = options;
  const config = ENTITIES[entityKey];

  console.log(`\n${config.label}`);
  console.log('─'.repeat(40));

  // Fetch valid IDs from Rondo Club
  if (verbose) console.log(`  Fetching from Rondo Club...`);
  const validIds = await fetchAllIds(config.endpoint, options);
  console.log(`  Rondo Club: ${validIds.size} records`);

  // Get local tracking data
  const localRecords = db.prepare(`
    SELECT ${config.keyColumn}, ${config.idColumn}
    FROM ${config.table}
  `).all();

  const tracked = localRecords.length;
  const withId = localRecords.filter(r => r[config.idColumn] != null).length;
  const withoutId = tracked - withId;

  console.log(`  Local DB: ${tracked} tracked (${withId} with ID, ${withoutId} without)`);

  // Find invalid rondo_club_ids (exist locally but not in Rondo Club)
  const invalidRecords = localRecords.filter(r => {
    return r[config.idColumn] != null && !validIds.has(r[config.idColumn]);
  });

  // Results
  const results = {
    entity: entityKey,
    label: config.label,
    rondoClubCount: validIds.size,
    localCount: tracked,
    withId: withId,
    withoutId: withoutId,
    invalidIds: invalidRecords.length,
    fixed: 0
  };

  // Report invalid IDs
  if (invalidRecords.length > 0) {
    console.log(`  ⚠ Invalid rondo_club_ids: ${invalidRecords.length}`);

    if (verbose) {
      const preview = invalidRecords.slice(0, 5);
      preview.forEach(r => {
        console.log(`    - ${r[config.keyColumn]}: ID ${r[config.idColumn]} not found`);
      });
      if (invalidRecords.length > 5) {
        console.log(`    ... and ${invalidRecords.length - 5} more`);
      }
    }

    // Fix if requested
    if (fix) {
      const stmt = db.prepare(`
        UPDATE ${config.table}
        SET ${config.idColumn} = NULL, last_synced_hash = NULL
        WHERE ${config.keyColumn} = ?
      `);

      for (const record of invalidRecords) {
        stmt.run(record[config.keyColumn]);
      }
      results.fixed = invalidRecords.length;
      console.log(`  ✓ Fixed: Nullified ${results.fixed} invalid IDs`);
    }
  } else {
    console.log(`  ✓ All IDs valid`);
  }

  // Report missing mappings
  if (withoutId > 0) {
    console.log(`  ℹ Missing IDs: ${withoutId} (will sync on next run)`);
  }

  return results;
}

/**
 * Generate summary report.
 * @param {Array<Object>} results - Array of verification results
 * @param {Object} options - Options object
 */
function printSummary(results, options) {
  console.log('\n');
  console.log('═'.repeat(50));
  console.log('VERIFICATION SUMMARY');
  console.log('═'.repeat(50));

  const headers = ['Entity', 'Rondo Club', 'Local', 'Invalid', 'Fixed'];
  const widths = [18, 10, 10, 10, 8];

  // Print header
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(''));
  console.log('─'.repeat(50));

  // Print rows
  for (const r of results) {
    const row = [
      r.label,
      r.rondoClubCount.toString(),
      r.localCount.toString(),
      r.invalidIds > 0 ? `⚠ ${r.invalidIds}` : '✓ 0',
      r.fixed > 0 ? r.fixed.toString() : '-'
    ];
    console.log(row.map((val, i) => val.padEnd(widths[i])).join(''));
  }

  console.log('─'.repeat(50));

  // Overall status
  const totalInvalid = results.reduce((sum, r) => sum + r.invalidIds, 0);
  const totalFixed = results.reduce((sum, r) => sum + r.fixed, 0);

  if (totalInvalid === 0) {
    console.log('\n✓ All data verified - no discrepancies found');
  } else if (options.fix && totalFixed === totalInvalid) {
    console.log(`\n✓ Fixed ${totalFixed} invalid ID mappings`);
    console.log('  Run sync to re-establish correct mappings');
  } else {
    console.log(`\n⚠ Found ${totalInvalid} invalid ID mappings`);
    if (!options.fix) {
      console.log('  Run with --fix to nullify invalid IDs');
    }
  }
}

async function run() {
  const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
  const fix = process.argv.includes('--fix');
  const help = process.argv.includes('--help') || process.argv.includes('-h');

  if (help) {
    console.log(`
Verify SQLite tracking data against Rondo Club WordPress.

Usage:
  node tools/verify-rondo-club-data.js [options]

Options:
  --fix      Nullify invalid rondo_club_ids (allows re-sync)
  --verbose  Show detailed output
  --help     Show this help

Verifies:
  - Members (rondo_club_members → /wp/v2/people)
  - Parents (rondo_club_parents → /wp/v2/people)
  - Teams (rondo_club_teams → /wp/v2/teams)
  - Commissies (rondo_club_commissies → /wp/v2/commissies)
`);
    process.exit(0);
  }

  console.log('═'.repeat(50));
  console.log('RONDO CLUB DATA VERIFICATION');
  console.log('═'.repeat(50));

  if (fix) {
    console.log('Mode: FIX (will nullify invalid IDs)');
  } else {
    console.log('Mode: VERIFY ONLY (use --fix to repair)');
  }

  const db = openDb();
  const results = [];

  try {
    // Verify each entity type
    for (const entityKey of Object.keys(ENTITIES)) {
      const result = await verifyEntity(db, entityKey, { verbose, fix });
      results.push(result);
    }

    // Print summary
    printSummary(results, { fix });

    // Exit code based on findings
    const totalInvalid = results.reduce((sum, r) => sum + r.invalidIds, 0);
    process.exitCode = totalInvalid > 0 && !fix ? 1 : 0;

  } finally {
    db.close();
  }
}

run().catch(err => {
  console.error('\nError:', err.message);
  if (process.argv.includes('--verbose')) {
    console.error(err.stack);
  }
  process.exit(1);
});
