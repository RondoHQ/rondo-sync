#!/usr/bin/env node
/**
 * Find and optionally delete orphaned important dates in Rondo Club
 *
 * Orphaned dates are those where related_people references a person ID
 * that no longer exists in Rondo Club.
 *
 * Usage:
 *   node scripts/find-orphan-dates.js          # List orphaned dates
 *   node scripts/find-orphan-dates.js --delete # Delete orphaned dates
 */
require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');

async function fetchAllPages(endpoint, options = {}) {
  const allItems = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`;
    try {
      const response = await rondoClubRequest(url, 'GET', null, options);
      const items = response.body;

      if (!Array.isArray(items) || items.length === 0) {
        break;
      }

      allItems.push(...items);
      console.log(`  Fetched page ${page}: ${items.length} items (total: ${allItems.length})`);

      if (items.length < perPage) {
        break;
      }
      page++;
    } catch (error) {
      console.error(`Error fetching page ${page}:`, error.message);
      break;
    }
  }

  return allItems;
}

async function findOrphanDates(options = {}) {
  const { deleteOrphans = false, verbose = false } = options;

  console.warn('DEPRECATED: find-orphan-dates.js is no longer needed. Birthdays now sync as fields.birthdate on person records.');
  console.log('');
  console.log('Fetching all people from Rondo Club...');
  const people = await fetchAllPages('wp/v2/people', { verbose });
  console.log(`Found ${people.length} people\n`);

  // Create set of valid person IDs
  const validPersonIds = new Set(people.map(p => p.id));

  console.log('Fetching all important dates from Rondo Club...');
  const dates = await fetchAllPages('wp/v2/important-dates', { verbose });
  console.log(`Found ${dates.length} dates\n`);

  // Find orphaned dates
  const orphanedDates = [];

  for (const date of dates) {
    const relatedPeople = date.fields?.related_people || [];

    // Check if ALL related people are gone (orphaned)
    // A date is orphaned if it has related_people but none of them exist anymore
    if (relatedPeople.length > 0) {
      const existingPeople = relatedPeople.filter(id => validPersonIds.has(id));
      if (existingPeople.length === 0) {
        orphanedDates.push({
          id: date.id,
          title: date.title?.rendered || 'Untitled',
          date_value: date.fields?.date_value || 'Unknown',
          related_people: relatedPeople
        });
      }
    }
  }

  console.log(`Found ${orphanedDates.length} orphaned dates:\n`);

  if (orphanedDates.length === 0) {
    console.log('No orphaned dates found!');
    return { total: dates.length, orphaned: 0, deleted: 0 };
  }

  // Display orphaned dates
  for (const orphan of orphanedDates) {
    console.log(`  ID ${orphan.id}: ${orphan.title} (${orphan.date_value}) - refs: ${orphan.related_people.join(', ')}`);
  }
  console.log('');

  let deleted = 0;
  if (deleteOrphans) {
    console.log('Deleting orphaned dates...\n');

    for (const orphan of orphanedDates) {
      try {
        await rondoClubRequest(`wp/v2/important-dates/${orphan.id}?force=true`, 'DELETE', null, { verbose });
        console.log(`  Deleted: ${orphan.id} - ${orphan.title}`);
        deleted++;
      } catch (error) {
        console.error(`  Failed to delete ${orphan.id}: ${error.message}`);
      }
    }

    console.log(`\nDeleted ${deleted}/${orphanedDates.length} orphaned dates`);
  } else {
    console.log('Run with --delete to remove these orphaned dates');
  }

  return { total: dates.length, orphaned: orphanedDates.length, deleted };
}

// CLI entry point
if (require.main === module) {
  const deleteOrphans = process.argv.includes('--delete');
  const verbose = process.argv.includes('--verbose');

  findOrphanDates({ deleteOrphans, verbose })
    .then(result => {
      console.log(`\nSummary: ${result.orphaned}/${result.total} dates were orphaned`);
      if (result.deleted > 0) {
        console.log(`Deleted: ${result.deleted} orphaned dates`);
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}

module.exports = { findOrphanDates };
