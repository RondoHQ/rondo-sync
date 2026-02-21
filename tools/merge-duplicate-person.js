#!/usr/bin/env node
/**
 * Merge duplicate person records in Rondo Club
 * Merges parent record into member record and cleans up relationships
 *
 * Usage: node scripts/merge-duplicate-person.js --parent=10987 --member=3893
 */
require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb } = require('../lib/rondo-club-db');

// Relationship type term IDs in the WordPress relationship_type taxonomy.
const RELATIONSHIP_TYPE = {
  PARENT: 2,  // "Parent" - the related person is a parent
  CHILD: 3,   // "Child" - the related person is a child
  SIBLING: 4  // "Sibling" - the related person is a sibling
};

async function mergePerson(parentId, memberId) {
  console.log(`Merging parent ${parentId} into member ${memberId}...`);

  // Step 1: Get both person records
  const [parentRes, memberRes] = await Promise.all([
    rondoClubRequest(`wp/v2/people/${parentId}`, 'GET'),
    rondoClubRequest(`wp/v2/people/${memberId}`, 'GET')
  ]);

  const parent = parentRes.body;
  const member = memberRes.body;

  console.log(`Parent: ${parent.acf.first_name} ${parent.acf.last_name || ''}`);
  console.log(`Member: ${member.acf.first_name} ${member.acf.last_name || ''}`);

  // Step 2: Get member's relationships, filter out sibling reference to parent
  const memberRelationships = (member.acf.relationships || [])
    .filter(r => r.related_person !== parentId);

  console.log(`Keeping ${memberRelationships.length} relationships on member`);

  // Step 3: Update member with cleaned relationships
  await rondoClubRequest(`wp/v2/people/${memberId}`, 'PUT', {
    acf: {
      first_name: member.acf.first_name,
      last_name: member.acf.last_name,
      relationships: memberRelationships
    }
  });
  console.log('Updated member relationships');

  // Step 4: Update children to reference member instead of parent
  const parentRelationships = parent.acf.relationships || [];
  const childIds = parentRelationships
    .filter(r => r.relationship_type === RELATIONSHIP_TYPE.CHILD) // Children
    .map(r => r.related_person)
    .filter(id => id !== memberId); // Don't update member itself

  console.log(`Found ${childIds.length} children to update: ${childIds.join(', ')}`);

  for (const childId of childIds) {
    try {
      const childRes = await rondoClubRequest(`wp/v2/people/${childId}`, 'GET');
      const child = childRes.body;

      // Replace parent relationship: parentId -> memberId
      const childRelationships = (child.acf.relationships || []).map(r => {
        if (r.related_person === parentId && r.relationship_type === RELATIONSHIP_TYPE.PARENT) {
          return { ...r, related_person: memberId };
        }
        return r;
      });

      // Deduplicate (in case member link already exists)
      const seen = new Set();
      const deduped = childRelationships.filter(r => {
        const key = `${r.related_person}-${r.relationship_type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      await rondoClubRequest(`wp/v2/people/${childId}`, 'PUT', {
        acf: {
          first_name: child.acf.first_name,
          last_name: child.acf.last_name,
          relationships: deduped
        }
      });
      console.log(`Updated child ${childId}: parent link changed to ${memberId}`);
    } catch (err) {
      console.error(`Failed to update child ${childId}: ${err.message}`);
    }
  }

  // Step 5: Delete parent record
  await rondoClubRequest(`wp/v2/people/${parentId}`, 'DELETE');
  console.log(`Deleted parent record ${parentId}`);

  // Step 6: Update database tracking
  const db = openDb();
  try {
    const email = parent.acf.contact_info?.find(c => c.contact_type === 'email')?.contact_value;
    if (email) {
      db.prepare('DELETE FROM rondo_club_parents WHERE email = ?').run(email);
      console.log(`Removed parent tracking for ${email}`);
    }
  } finally {
    db.close();
  }

  console.log('\nMerge complete!');
  console.log(`Member ${memberId} now has the child relationships.`);
  console.log(`Parent ${parentId} has been deleted.`);
}

// Parse arguments
const args = process.argv.slice(2);
const parentArg = args.find(a => a.startsWith('--parent='));
const memberArg = args.find(a => a.startsWith('--member='));

if (!parentArg || !memberArg) {
  console.error('Usage: node scripts/merge-duplicate-person.js --parent=<id> --member=<id>');
  process.exit(1);
}

const parentId = parseInt(parentArg.split('=')[1]);
const memberId = parseInt(memberArg.split('=')[1]);

if (isNaN(parentId) || isNaN(memberId)) {
  console.error('Invalid IDs provided');
  process.exit(1);
}

mergePerson(parentId, memberId)
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Merge failed:', err.message);
    process.exit(1);
  });
