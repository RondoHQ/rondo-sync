require('dotenv/config');

const { openDb } = require('../lib/rondo-club-db');

const RONDO_URL = process.env.RONDO_URL;
const RONDO_USERNAME = process.env.RONDO_USERNAME;
const RONDO_APP_PASSWORD = process.env.RONDO_APP_PASSWORD;

const PARENT_TYPE_ID = 2;
const CHILD_TYPE_ID = 3;
const OLD_CHILD_TYPE_ID = 9;

function hasRelationshipType(relationship, typeId) {
  const type = relationship.relationship_type_id;
  if (Array.isArray(type)) {
    return type.includes(typeId);
  }
  return type === typeId;
}

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
 * Normalize a name for comparison (trim + lowercase + collapse whitespace).
 */
function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Detect parents that were wrongly merged into a child or sibling's WP post.
 *
 * Two patterns are detected:
 *
 * 1. "own child" — parent.rondo_club_id matches the rondo_club_id of one of the
 *    parent's own listed children. This is the original bug pattern.
 *
 * 2. "sibling-by-shared-email" — parent.rondo_club_id matches a member's WP post
 *    that is NOT in this parent's listed children, but is a child in some other
 *    family record (or whose name does not match the parent's). Caused by a
 *    sibling sharing the family inbox while their Sportlink record lacked a
 *    NameParentN value (so they were dropped from this parent's childKnvbIds).
 *
 * Cleanup steps:
 *  - reset parent's rondo_club_id and last_synced_hash so the next sync creates
 *    a fresh parent post
 *  - remove "Child" relationships on the wrongly-merged WP post that point to
 *    this parent's children
 *  - remove "Parent" relationships on each child WP post that point back to the
 *    wrongly-merged post
 *  - keep self-referential cleanup for the legacy pattern
 */
async function runUnmerge(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== UNMERGING PARENTS FROM CHILDREN ===');
  console.log('');

  const db = openDb();

  try {
    const parents = db.prepare('SELECT email, rondo_club_id, data_json FROM rondo_club_parents WHERE rondo_club_id IS NOT NULL').all();

    // Build set of all child KNVB IDs across all parent records so we can
    // recognise a sibling-by-shared-email regardless of which family they
    // were nominally attached to.
    const allChildKnvbIds = new Set();
    for (const p of parents) {
      const data = JSON.parse(p.data_json);
      for (const knvbId of data.childKnvbIds || []) {
        allChildKnvbIds.add(knvbId);
      }
    }

    const toFix = [];
    for (const p of parents) {
      const data = JSON.parse(p.data_json);
      const childKnvbIds = data.childKnvbIds || [];
      const parentFirst = normalizeName(data.data?.fields?.first_name);
      const parentLast = normalizeName(data.data?.fields?.last_name);

      // Look up the member, if any, whose WP post equals this parent's rondo_club_id.
      const matchedMember = db.prepare(
        'SELECT knvb_id, data_json FROM rondo_club_members WHERE rondo_club_id = ?'
      ).get(p.rondo_club_id);

      if (!matchedMember) continue; // rondo_club_id points to a non-member post (pure parent) — fine

      // Decide if this is a false merge.
      const memberData = JSON.parse(matchedMember.data_json || '{}');
      const memberFirst = normalizeName(memberData.fields?.first_name);
      const memberLast = normalizeName(memberData.fields?.last_name);
      const namesMatch = parentFirst && parentLast && parentFirst === memberFirst && parentLast === memberLast;

      const isOwnChild = childKnvbIds.includes(matchedMember.knvb_id);
      const isOtherFamilyChild = !isOwnChild && allChildKnvbIds.has(matchedMember.knvb_id);

      // Treat as bug when either:
      //  - the matched member is in this parent's children, OR
      //  - the matched member is a child in any other family, OR
      //  - names clearly differ (member is unlikely to actually be this parent)
      const isBug = isOwnChild || isOtherFamilyChild || !namesMatch;
      if (!isBug) continue;

      // Resolve KNVB IDs of this parent's listed children to Rondo Club IDs
      // so we can scrub PARENT relationships on those posts.
      const childRondoClubIds = childKnvbIds
        .map(knvbId => db.prepare('SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?').get(knvbId)?.rondo_club_id)
        .filter(Boolean);

      toFix.push({
        email: p.email,
        parentName: [data.data?.fields?.first_name, data.data?.fields?.last_name].filter(Boolean).join(' ') || p.email,
        wrongRondoClubId: p.rondo_club_id,
        wrongMemberKnvbId: matchedMember.knvb_id,
        childRondoClubIds,
        pattern: isOwnChild ? 'own-child' : (isOtherFamilyChild ? 'sibling' : 'name-mismatch')
      });
    }

    console.log(`Found ${toFix.length} parents incorrectly merged into a member's post`);
    if (verbose) {
      const by = toFix.reduce((acc, f) => ({ ...acc, [f.pattern]: (acc[f.pattern] || 0) + 1 }), {});
      console.log(`  By pattern: ${JSON.stringify(by)}`);
    }
    console.log('');

    let reset = 0;
    let cleaned = 0;
    let errors = 0;

    for (const fix of toFix) {
      if (verbose) {
        console.log(`${fix.parentName} (${fix.email}) → merged into ${fix.pattern} post ${fix.wrongRondoClubId} (member knvb ${fix.wrongMemberKnvbId})`);
      }

      if (dryRun) {
        reset++;
        continue;
      }

      try {
        // 1. Reset parent's tracking so next sync creates a fresh post.
        db.prepare('UPDATE rondo_club_parents SET rondo_club_id = NULL, last_synced_hash = NULL WHERE email = ?').run(fix.email);
        reset++;

        // 2. Scrub wrong "Child" relationships on the falsely-merged post.
        try {
          const wrongPost = await rondoClubRequest(`wp/v2/people/${fix.wrongRondoClubId}`);
          const relationships = wrongPost.fields?.relationships || [];

          // Remove:
          //  - self-referential rows (legacy own-child pattern)
          //  - "Child" relationships pointing to this parent's children
          const childIdSet = new Set(fix.childRondoClubIds);
          const cleanedRels = relationships.filter(r => {
            if (r.related_person_id === fix.wrongRondoClubId) return false;
            const isChildType = hasRelationshipType(r, CHILD_TYPE_ID) || hasRelationshipType(r, OLD_CHILD_TYPE_ID);
            if (isChildType && childIdSet.has(r.related_person_id)) return false;
            return true;
          });

          if (cleanedRels.length < relationships.length) {
            await rondoClubRequest(`wp/v2/people/${fix.wrongRondoClubId}`, 'PUT', {
              fields: {
                first_name: wrongPost.fields?.first_name || '',
                last_name: wrongPost.fields?.last_name || '',
                relationships: cleanedRels
              }
            });
            cleaned++;
            if (verbose) console.log(`  Removed ${relationships.length - cleanedRels.length} bad rel(s) from post ${fix.wrongRondoClubId}`);
          }
        } catch (e) {
          if (verbose) console.log(`  Warning: could not clean wrong post ${fix.wrongRondoClubId}: ${e.message}`);
        }

        // 3. Scrub "Parent" relationships on each affected child that point to the wrong post.
        for (const childId of fix.childRondoClubIds) {
          try {
            const childPost = await rondoClubRequest(`wp/v2/people/${childId}`);
            const relationships = childPost.fields?.relationships || [];
            const cleanedRels = relationships.filter(r => !(
              r.related_person_id === fix.wrongRondoClubId && hasRelationshipType(r, PARENT_TYPE_ID)
            ));

            if (cleanedRels.length < relationships.length) {
              await rondoClubRequest(`wp/v2/people/${childId}`, 'PUT', {
                fields: {
                  first_name: childPost.fields?.first_name || '',
                  last_name: childPost.fields?.last_name || '',
                  relationships: cleanedRels
                }
              });
              if (verbose) console.log(`  Removed parent link on child ${childId} → ${fix.wrongRondoClubId}`);
            }
          } catch (e) {
            if (verbose) console.log(`  Warning: could not clean child post ${childId}: ${e.message}`);
          }
        }

        if (reset % 25 === 0) {
          console.log(`  Progress: ${reset}/${toFix.length}...`);
        }
      } catch (error) {
        errors++;
        console.error(`  ERROR for ${fix.email}: ${error.message}`);
      }
    }

    console.log('');
    console.log('=== RESULTS ===');
    console.log(`Bad merges detected:           ${toFix.length}`);
    if (dryRun) {
      console.log(`Would reset:                   ${reset}`);
      console.log('');
      console.log('Run with --fix to reset parent tracking and clean WP relationships.');
      console.log('After running, do a people sync to create the parent posts:');
      console.log('  ssh root@46.202.155.16 "cd /home/rondo && scripts/sync.sh people"');
    } else {
      console.log(`Parent tracking reset:         ${reset}`);
      console.log(`Wrong posts cleaned:           ${cleaned}`);
      console.log(`Errors:                        ${errors}`);
    }
  } finally {
    db.close();
  }
}

// CLI entry point
if (require.main === module) {
  const dryRun = !process.argv.includes('--fix');
  const verbose = process.argv.includes('--verbose');

  runUnmerge({ dryRun, verbose })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { runUnmerge };
