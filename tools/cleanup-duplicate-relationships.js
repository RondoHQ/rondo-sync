#!/usr/bin/env node
/**
 * Cleanup script for duplicate and self-referential relationships
 *
 * Scans all people in Rondo Club and removes:
 * - Duplicate relationships (same person + type)
 * - Self-referential relationships (pointing to themselves)
 */

require('dotenv/config');
const { rondoClubRequest } = require('../lib/rondo-club-client');

async function cleanupAllRelationships() {
  console.log('Scanning all people for relationship issues...');

  let page = 1;
  let totalFixed = 0;
  let totalPeople = 0;

  while (true) {
    let people;
    try {
      const response = await rondoClubRequest(`wp/v2/people?per_page=100&page=${page}`, 'GET');
      people = response.body;
    } catch (e) {
      if (e.message.includes('400')) break; // No more pages
      throw e;
    }

    if (!people || people.length === 0) break;
    totalPeople += people.length;

    for (const person of people) {
      const relationships = person.fields?.relationships || [];
      if (relationships.length === 0) continue;

      // Deduplicate and remove self-references
      const seen = new Set();
      const deduped = [];
      let issues = 0;

      for (const rel of relationships) {
        // Skip self-referential
        if (rel.related_person_id === person.id) {
          issues++;
          continue;
        }

        const key = `${rel.related_person_id}-${rel.relationship_type_id}`;
        if (seen.has(key)) {
          issues++;
          continue;
        }
        seen.add(key);
        deduped.push(rel);
      }

      if (issues > 0) {
        console.log(`Fixing ${person.id} (${person.fields.first_name} ${person.fields.last_name}): ${relationships.length} -> ${deduped.length} relationships`);

        await rondoClubRequest(
          `wp/v2/people/${person.id}`,
          'PUT',
          {
            fields: {
              first_name: person.fields.first_name,
              last_name: person.fields.last_name,
              relationships: deduped
            }
          }
        );
        totalFixed++;
      }
    }

    process.stderr.write(`Scanned page ${page} (${totalPeople} people, ${totalFixed} fixed)...\r`);
    page++;
  }

  console.log(`\nDone! Scanned ${totalPeople} people, fixed ${totalFixed} with relationship issues.`);
}

cleanupAllRelationships().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
