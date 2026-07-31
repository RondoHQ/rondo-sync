#!/usr/bin/env node
/**
 * Delete duplicate entries from Rondo Club WordPress
 *
 * Identifies duplicates by finding KNVB IDs that appear more than once,
 * then deletes the NEWER entries (keeping the oldest original).
 *
 * Usage:
 *   node scripts/delete-duplicates.js --dry-run    # Show what would be deleted
 *   node scripts/delete-duplicates.js              # Actually delete duplicates
 */

require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');

const RONDO_URL = process.env.RONDO_URL;
const RONDO_USERNAME = process.env.RONDO_USERNAME;
const RONDO_APP_PASSWORD = process.env.RONDO_APP_PASSWORD;

async function getAllPeople() {
  const people = [];
  let page = 1;

  console.log('Fetching all people from Rondo Club...');

  while (true) {
    const auth = Buffer.from(`${RONDO_USERNAME}:${RONDO_APP_PASSWORD}`).toString('base64');
    const response = await fetch(
      `${RONDO_URL}/wp-json/wp/v2/people?per_page=100&page=${page}&_fields=id,date,fields`,
      { headers: { 'Authorization': `Basic ${auth}` } }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch people: ${response.status}`);
    }

    const batch = await response.json();
    if (batch.length === 0) break;

    people.push(...batch);
    console.log(`  Page ${page}: ${people.length} total`);

    if (batch.length < 100) break;
    page++;
  }

  return people;
}

function findDuplicates(people) {
  // Group by KNVB ID
  const byKnvbId = new Map();

  for (const person of people) {
    const knvbId = person.fields?.['knvb_id'];
    if (!knvbId) continue; // Skip parents (no KNVB ID)

    if (!byKnvbId.has(knvbId)) {
      byKnvbId.set(knvbId, []);
    }
    byKnvbId.get(knvbId).push(person);
  }

  // Find duplicates (KNVB IDs with more than one entry)
  const duplicates = [];

  for (const [knvbId, entries] of byKnvbId) {
    if (entries.length > 1) {
      // Sort by date (oldest first)
      entries.sort((a, b) => new Date(a.date) - new Date(b.date));

      // Keep the oldest, mark the rest as duplicates
      const original = entries[0];
      const dupes = entries.slice(1);

      duplicates.push({
        knvbId,
        original: { id: original.id, date: original.date },
        duplicates: dupes.map(d => ({ id: d.id, date: d.date }))
      });
    }
  }

  return duplicates;
}

async function deletePerson(id, dryRun) {
  if (dryRun) {
    return { success: true, dryRun: true };
  }

  try {
    await rondoClubRequest(`wp/v2/people/${id}?force=true`, 'DELETE', null, {});
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(dryRun ? '=== DRY RUN - No changes will be made ===' : '=== DELETING DUPLICATES ===');
  console.log('');

  // Fetch all people
  const people = await getAllPeople();
  console.log(`\nTotal people in Rondo Club: ${people.length}`);

  // Find duplicates
  const duplicateGroups = findDuplicates(people);

  if (duplicateGroups.length === 0) {
    console.log('\nNo duplicates found!');
    return;
  }

  // Count total duplicates to delete
  const totalToDelete = duplicateGroups.reduce((sum, g) => sum + g.duplicates.length, 0);

  console.log(`\nFound ${duplicateGroups.length} KNVB IDs with duplicates`);
  console.log(`Total duplicate entries to delete: ${totalToDelete}`);
  console.log('');

  // Show first 10 examples
  console.log('Examples (first 10):');
  for (const group of duplicateGroups.slice(0, 10)) {
    console.log(`  ${group.knvbId}:`);
    console.log(`    Original: ID ${group.original.id} (${group.original.date})`);
    for (const dupe of group.duplicates) {
      console.log(`    Duplicate: ID ${dupe.id} (${dupe.date}) <- will delete`);
    }
  }
  if (duplicateGroups.length > 10) {
    console.log(`  ... and ${duplicateGroups.length - 10} more`);
  }
  console.log('');

  if (dryRun) {
    console.log('Run without --dry-run to delete these duplicates.');
    return;
  }

  // Delete duplicates
  console.log('Deleting duplicates...');
  let deleted = 0;
  let errors = 0;

  for (const group of duplicateGroups) {
    for (const dupe of group.duplicates) {
      const result = await deletePerson(dupe.id, dryRun);
      if (result.success) {
        deleted++;
        if (deleted % 50 === 0) {
          console.log(`  Deleted ${deleted}/${totalToDelete}...`);
        }
      } else {
        errors++;
        console.error(`  Failed to delete ${dupe.id}: ${result.error}`);
      }
    }
  }

  console.log('');
  console.log('=== COMPLETE ===');
  console.log(`Deleted: ${deleted}`);
  console.log(`Errors: ${errors}`);
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
