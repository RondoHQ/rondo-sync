require('dotenv/config');

const { openDb } = require('../lib/rondo-club-db');
const { rondoClubRequest } = require('../lib/rondo-club-client');

/**
 * Clean up duplicate former member posts in WordPress.
 *
 * Former member imports ran before dedup was fixed, creating duplicate posts
 * for the same person. This script:
 *
 * 1. Finds duplicate posts sharing the same KNVB ID
 * 2. Keeps the post tracked in the local rondo_club_members DB
 * 3. Deletes the untracked duplicate(s)
 * 4. Also removes no-KNVB posts that match by name to a post with KNVB ID
 *
 * Dry run by default. Use --delete to actually remove duplicates.
 */
async function runCleanup(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== DELETING DUPLICATE FORMER MEMBERS ===');
  console.log('');

  const db = openDb();

  try {
    // Build set of tracked rondo_club_ids from local DB
    const tracked = new Set();
    const rows = db.prepare('SELECT rondo_club_id FROM rondo_club_members WHERE rondo_club_id IS NOT NULL').all();
    for (const r of rows) tracked.add(r.rondo_club_id);
    console.log(`Local DB tracks ${tracked.size} rondo_club_ids`);

    // Fetch all former members from WordPress
    console.log('Fetching all former members from WordPress...');
    let page = 1;
    const allFormer = [];
    while (true) {
      const { status, body } = await rondoClubRequest(
        `wp/v2/people?per_page=100&page=${page}&former_member=true`, 'GET'
      );
      if (status !== 200 || !body.length) break;
      allFormer.push(...body);
      if (body.length < 100) break;
      page++;
      if (page % 10 === 0) console.log(`  Fetched ${allFormer.length} so far (page ${page})...`);
    }
    console.log(`Fetched ${allFormer.length} former members from rondo_club_members DB`);
    console.log('');

    // Group by KNVB ID
    const byKnvb = {};
    const noKnvb = [];
    for (const p of allFormer) {
      const knvbId = p.fields?.['knvb_id'];
      if (!knvbId) {
        noKnvb.push(p);
        continue;
      }
      if (!byKnvb[knvbId]) byKnvb[knvbId] = [];
      byKnvb[knvbId].push(p);
    }

    // --- Phase 1: KNVB ID duplicates ---
    const knvbDupes = Object.entries(byKnvb).filter(([_, posts]) => posts.length > 1);
    console.log(`=== Phase 1: KNVB ID duplicates ===`);
    console.log(`Found ${knvbDupes.length} KNVB IDs with duplicate posts`);

    let deletedKnvb = 0;
    let errorsKnvb = 0;

    for (const [knvbId, posts] of knvbDupes) {
      // Determine which to keep: prefer the one tracked in local DB
      const trackedPosts = posts.filter(p => tracked.has(p.id));
      const untrackedPosts = posts.filter(p => !tracked.has(p.id));

      let keep;
      let toDelete;

      if (trackedPosts.length === 1) {
        // Ideal case: exactly one is tracked
        keep = trackedPosts[0];
        toDelete = untrackedPosts;
      } else if (trackedPosts.length > 1) {
        // Multiple tracked — keep the newest, delete the rest
        const sorted = [...trackedPosts].sort((a, b) => b.id - a.id);
        keep = sorted[0];
        toDelete = [...sorted.slice(1), ...untrackedPosts];
      } else {
        // None tracked — keep the newest
        const sorted = [...posts].sort((a, b) => b.id - a.id);
        keep = sorted[0];
        toDelete = sorted.slice(1);
      }

      for (const post of toDelete) {
        if (verbose) {
          console.log(`  KNVB ${knvbId}: delete ${post.id} (${post.title?.rendered}), keep ${keep.id}`);
        }

        if (!dryRun) {
          try {
            await rondoClubRequest(`wp/v2/people/${post.id}?force=true`, 'DELETE');
            deletedKnvb++;
            if (deletedKnvb % 50 === 0) {
              console.log(`  Progress: ${deletedKnvb} deleted...`);
            }
          } catch (err) {
            errorsKnvb++;
            console.error(`  ERROR deleting ${post.id}: ${err.message}`);
          }
        } else {
          deletedKnvb++;
        }
      }
    }

    console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${deletedKnvb} KNVB duplicate posts`);
    if (errorsKnvb) console.log(`Errors: ${errorsKnvb}`);
    console.log('');

    // --- Phase 2: No-KNVB posts matching by name ---
    // Build name→post map from posts WITH KNVB IDs (single entries only after dedup)
    const nameToKnvbPost = {};
    for (const [_, posts] of Object.entries(byKnvb)) {
      // After phase 1, conceptually only one survives per KNVB ID
      // Use the first post's name as key
      const name = posts[0].title?.rendered;
      if (name) nameToKnvbPost[name] = posts[0];
    }

    const nameMatched = noKnvb.filter(p => nameToKnvbPost[p.title?.rendered]);
    console.log(`=== Phase 2: No-KNVB name-matched duplicates ===`);
    console.log(`Found ${nameMatched.length} no-KNVB posts matching a KNVB-tracked person by name`);

    let deletedName = 0;
    let errorsName = 0;

    for (const post of nameMatched) {
      const match = nameToKnvbPost[post.title?.rendered];
      if (verbose) {
        console.log(`  Name "${post.title?.rendered}": delete ${post.id} (no KNVB), keep ${match.id} (KNVB: ${match.fields?.['knvb_id']})`);
      }

      if (!dryRun) {
        try {
          await rondoClubRequest(`wp/v2/people/${post.id}?force=true`, 'DELETE');
          deletedName++;
        } catch (err) {
          errorsName++;
          console.error(`  ERROR deleting ${post.id}: ${err.message}`);
        }
      } else {
        deletedName++;
      }
    }

    console.log(`${dryRun ? 'Would delete' : 'Deleted'}: ${deletedName} name-matched duplicate posts`);
    if (errorsName) console.log(`Errors: ${errorsName}`);
    console.log('');

    // --- Summary ---
    const orphans = noKnvb.filter(p => !nameToKnvbPost[p.title?.rendered]);
    console.log('=== SUMMARY ===');
    console.log(`KNVB duplicates ${dryRun ? 'to delete' : 'deleted'}:  ${deletedKnvb}`);
    console.log(`Name-matched ${dryRun ? 'to delete' : 'deleted'}:     ${deletedName}`);
    console.log(`Total ${dryRun ? 'to delete' : 'deleted'}:            ${deletedKnvb + deletedName}`);
    console.log(`Remaining orphans (no KNVB, no match): ${orphans.length}`);

    if (dryRun) {
      console.log('');
      console.log('Run with --delete to execute.');
    }
  } finally {
    db.close();
  }
}

// CLI entry point
if (require.main === module) {
  const dryRun = !process.argv.includes('--delete');
  const verbose = process.argv.includes('--verbose');

  runCleanup({ dryRun, verbose })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { runCleanup };
