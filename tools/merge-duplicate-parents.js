require('dotenv/config');

const { openDb } = require('../lib/rondo-club-db');

// Relationship type term IDs in the WordPress relationship_type taxonomy.
const RELATIONSHIP_TYPE = {
  PARENT: 2,  // "Parent" - the related person is a parent
  CHILD: 3,   // "Child" - the related person is a child
  SIBLING: 4  // "Sibling" - the related person is a sibling
};

const RONDO_URL = process.env.RONDO_URL;
const RONDO_USERNAME = process.env.RONDO_USERNAME;
const RONDO_APP_PASSWORD = process.env.RONDO_APP_PASSWORD;

async function rondoClubRequest(endpoint, method = 'GET', body = null) {
  const url = `${RONDO_URL}/wp-json/${endpoint}`;
  const auth = Buffer.from(`${RONDO_USERNAME}:${RONDO_APP_PASSWORD}`).toString('base64');

  const options = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    let errorDetails = '';
    try {
      errorDetails = JSON.stringify(await response.json());
    } catch (e) {
      errorDetails = `status ${response.status}`;
    }
    throw new Error(`${method} ${endpoint} failed: ${response.status} - ${errorDetails}`);
  }
  return response.json();
}

/**
 * Merge duplicate parent posts into member posts.
 *
 * When a person is both a member and a parent, rondo-sync may have created
 * two WordPress posts: one from member sync (with KNVB ID) and one from
 * parent sync (without KNVB ID). This script merges the parent's child
 * relationships into the member post and deletes the duplicate.
 */
async function runMerge(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== MERGING DUPLICATE PARENTS ===');
  console.log('');

  const db = openDb();

  try {
    // Step 1: Find all parent emails with a different rondo_club_id than their member
    const duplicates = db.prepare(`
      SELECT DISTINCT
        p.email,
        p.rondo_club_id as parent_sid,
        m.rondo_club_id as member_sid
      FROM rondo_club_parents p
      JOIN rondo_club_members m ON LOWER(m.email) = LOWER(p.email)
      WHERE m.rondo_club_id IS NOT NULL
        AND p.rondo_club_id IS NOT NULL
        AND m.rondo_club_id != p.rondo_club_id
      GROUP BY p.email
    `).all();

    console.log(`Found ${duplicates.length} parent/member duplicates to merge`);
    console.log('');

    let merged = 0;
    let deleted = 0;
    let repointed = 0;
    let errors = 0;

    for (const dup of duplicates) {
      const { email, parent_sid, member_sid } = dup;

      if (verbose) {
        console.log(`Processing: ${email}`);
        console.log(`  Parent post: ${parent_sid} → merge into member post: ${member_sid}`);
      }

      if (dryRun) {
        merged++;
        continue;
      }

      try {
        // Fetch parent post to get its child relationships
        let parentRelationships = [];
        try {
          const parentPost = await rondoClubRequest(`wp/v2/people/${parent_sid}`);
          parentRelationships = parentPost.acf?.relationships || [];
        } catch (e) {
          if (e.message.includes('404')) {
            if (verbose) console.log(`  Parent post ${parent_sid} already deleted, updating tracking`);
            db.prepare('UPDATE rondo_club_parents SET rondo_club_id = ? WHERE LOWER(email) = LOWER(?)').run(member_sid, email);
            merged++;
            continue;
          }
          throw e;
        }

        // Fetch member post to get its existing relationships
        const memberPost = await rondoClubRequest(`wp/v2/people/${member_sid}`);
        const memberRelationships = memberPost.acf?.relationships || [];

        // Merge: add child relationships from parent that aren't already on the member
        const existingRelatedIds = new Set(memberRelationships.map(r => r.related_person));
        const newRelationships = parentRelationships.filter(r =>
          r.related_person !== member_sid && // No self-reference
          !existingRelatedIds.has(r.related_person)
        );

        if (newRelationships.length > 0 || memberRelationships.length > 0) {
          const mergedRelationships = [...memberRelationships, ...newRelationships];
          await rondoClubRequest(`wp/v2/people/${member_sid}`, 'PUT', {
            acf: {
              first_name: memberPost.acf?.first_name || '',
              last_name: memberPost.acf?.last_name || '',
              relationships: mergedRelationships
            }
          });
          if (verbose) {
            console.log(`  Merged ${newRelationships.length} new relationship(s) into member post ${member_sid}`);
          }
        }

        // Repoint: find all people that reference the parent post and update to member post
        // This handles children that have "parent" relationship pointing to the duplicate
        const childRelationships = parentRelationships.filter(r => {
          const type = r.relationship_type;
          // Child type (array or integer)
          return Array.isArray(type) ? type.includes(RELATIONSHIP_TYPE.CHILD) : type === RELATIONSHIP_TYPE.CHILD;
        });

        for (const childRel of childRelationships) {
          const childId = childRel.related_person;
          if (!childId || childId === member_sid) continue;

          try {
            const childPost = await rondoClubRequest(`wp/v2/people/${childId}`);
            const childRels = childPost.acf?.relationships || [];
            let changed = false;

            const updatedRels = childRels.map(r => {
              if (r.related_person === parent_sid) {
                changed = true;
                return { ...r, related_person: member_sid };
              }
              return r;
            });

            if (changed) {
              await rondoClubRequest(`wp/v2/people/${childId}`, 'PUT', {
                acf: {
                  first_name: childPost.acf?.first_name || '',
                  last_name: childPost.acf?.last_name || '',
                  relationships: updatedRels
                }
              });
              repointed++;
              if (verbose) console.log(`  Repointed child ${childId}: ${parent_sid} → ${member_sid}`);
            }
          } catch (e) {
            if (!e.message.includes('404')) {
              console.error(`  Warning: could not repoint child ${childId}: ${e.message}`);
            }
          }
        }

        // Delete the duplicate parent post
        await rondoClubRequest(`wp/v2/people/${parent_sid}?force=true`, 'DELETE');
        deleted++;
        if (verbose) console.log(`  Deleted duplicate parent post ${parent_sid}`);

        // Update parent tracking to point to member's rondo_club_id
        db.prepare('UPDATE rondo_club_parents SET rondo_club_id = ? WHERE LOWER(email) = LOWER(?)').run(member_sid, email);

        merged++;
        if (merged % 25 === 0) {
          console.log(`  Progress: ${merged}/${duplicates.length}...`);
        }
      } catch (error) {
        errors++;
        console.error(`  ERROR merging ${email}: ${error.message}`);
      }
    }

    console.log('');
    console.log('=== RESULTS ===');
    console.log(`Duplicates found:      ${duplicates.length}`);
    if (dryRun) {
      console.log(`Would merge:           ${merged}`);
      console.log('');
      console.log('Run with --merge to execute.');
    } else {
      console.log(`Merged:                ${merged}`);
      console.log(`Parent posts deleted:  ${deleted}`);
      console.log(`Child refs repointed:  ${repointed}`);
      console.log(`Errors:                ${errors}`);
    }
  } finally {
    db.close();
  }
}

// CLI entry point
if (require.main === module) {
  const dryRun = !process.argv.includes('--merge');
  const verbose = process.argv.includes('--verbose');

  runMerge({ dryRun, verbose })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { runMerge };
