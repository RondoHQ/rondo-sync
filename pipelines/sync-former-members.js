require('dotenv/config');

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const { SportlinkSession } = require('../lib/sportlink-session');
const FormData = require('form-data');
const { runDownloadInactive } = require('../steps/download-inactive-members');
const { preparePerson, isValidMember } = require('../steps/prepare-rondo-club-members');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb, getAllTrackedMembers, upsertMembers, updateSyncState, computeSourceHash, getMembersByPhotoState, updatePhotoState } = require('../lib/rondo-club-db');
const { loginToSportlink } = require('../lib/sportlink-login');
const { parseMemberHeaderResponse, downloadPhotoFromUrl } = require('../lib/photo-utils');
const { readEnv } = require('../lib/utils');
const { createDebugLogger } = require('../lib/log-adapters');
const { RunTracker } = require('../lib/run-tracker');

const FORMER_MEMBERS_CACHE = path.join(process.cwd(), 'data', 'former-members.json');

/**
 * Import former members from Sportlink to Rondo Club
 * @param {Object} options
 * @param {boolean} [options.dryRun=true] - Dry run mode (default)
 * @param {boolean} [options.verbose=false] - Verbose output
 * @param {boolean} [options.skipDownload=false] - Skip download, use cached data
 * @param {boolean} [options.skipPhotos=false] - Skip photo download and upload
 * @param {boolean} [options.force=false] - Force update existing former members
 * @returns {Promise<{downloaded: number, toSync: number, synced: number, skippedActive: number, skippedFormer: number, failed: number, errors: Array, photos: Object}>}
 */
async function runImport(options = {}) {
  const { dryRun = true, verbose = false, skipDownload = false, skipPhotos = false, force = false } = options;

  const tracker = dryRun ? null : new RunTracker('former-members');
  if (tracker) tracker.startRun();

  console.log(dryRun ? '=== DRY RUN ===' : '=== IMPORTING FORMER MEMBERS ===');
  console.log('');

  const stats = {
    downloaded: 0,
    toSync: 0,
    synced: 0,
    skippedActive: 0,
    skippedFormer: 0,
    failed: 0,
    errors: [],
    photos: {
      downloaded: 0,
      uploaded: 0,
      noPhoto: 0,
      failed: 0
    }
  };

  // Step 1: Download inactive members
  let inactiveMembers = [];

  if (skipDownload) {
    if (verbose) console.log('Skipping download, loading from cache...');
    try {
      const cachedData = JSON.parse(fs.readFileSync(FORMER_MEMBERS_CACHE, 'utf8'));
      inactiveMembers = cachedData.members || [];
      stats.downloaded = inactiveMembers.length;
      console.log(`Loaded ${stats.downloaded} inactive members from cache`);
    } catch (err) {
      console.error(`Error reading cache file: ${err.message}`);
      console.error('Run without --skip-download to fetch fresh data.');
      if (tracker) tracker.endRun('failure', stats);
      return stats;
    }
  } else {
    if (verbose) console.log('Downloading inactive members from Sportlink...');
    const downloadResult = await runDownloadInactive({ verbose });

    if (!downloadResult.success) {
      console.error(`Download failed: ${downloadResult.error}`);
      if (tracker) tracker.endRun('failure', stats);
      return stats;
    }

    inactiveMembers = downloadResult.members || [];
    stats.downloaded = inactiveMembers.length;
    console.log(`Downloaded ${stats.downloaded} inactive members from Sportlink`);

    // Cache the results
    try {
      fs.writeFileSync(FORMER_MEMBERS_CACHE, JSON.stringify({ members: inactiveMembers }, null, 2));
      if (verbose) console.log(`Cached results to ${FORMER_MEMBERS_CACHE}`);
    } catch (err) {
      console.error(`Warning: Could not cache results: ${err.message}`);
    }
  }

  console.log('');

  // Step 2: Prepare and filter members
  if (verbose) console.log('Preparing and filtering members...');

  const db = openDb();
  let trackedMembers;
  try {
    trackedMembers = getAllTrackedMembers(db);
  } finally {
    db.close();
  }

  // Create a map of tracked members by KNVB ID
  const trackedByKnvbId = new Map();
  trackedMembers.forEach(m => {
    trackedByKnvbId.set(m.knvb_id, m);
  });

  const toSync = [];
  const seenKnvbIds = new Set();
  let invalidCount = 0;

  for (const member of inactiveMembers) {
    // Validate member has required fields
    if (!isValidMember(member)) {
      invalidCount++;
      if (verbose) {
        const reason = !member.PublicPersonId ? 'missing KNVB ID' : 'missing first name';
        console.log(`  Skipping invalid member: ${reason}`);
      }
      continue;
    }

    const knvbId = member.PublicPersonId;

    // Skip duplicates within the same download batch
    if (seenKnvbIds.has(knvbId)) {
      if (verbose) console.log(`  Skipping ${knvbId}: duplicate in download data`);
      continue;
    }
    seenKnvbIds.add(knvbId);

    const tracked = trackedByKnvbId.get(knvbId);

    // Skip if member already exists in database with a rondo_club_id (unless force)
    if (tracked && tracked.rondo_club_id) {
      if (!force) {
        stats.skippedFormer++;
        if (verbose) console.log(`  Skipping ${knvbId}: already synced as former or active member`);
        continue;
      }
    }

    // Prepare person data using shared preparePerson function
    const prepared = preparePerson(member);

    // Override former_member flag to true (preparePerson sets it to false for active members)
    prepared.data.acf.former_member = true;

    toSync.push({
      knvb_id: knvbId,
      prepared: prepared,
      rondo_club_id: (tracked && tracked.rondo_club_id) ? tracked.rondo_club_id : null
    });
  }

  stats.toSync = toSync.length;

  console.log(`${stats.toSync} former members to sync`);
  console.log(`${stats.skippedFormer} already exist (active or former)`);
  console.log(`${invalidCount} invalid (missing KNVB ID or first name)`);
  console.log('');

  // Step 3: Sync to Rondo Club
  if (dryRun) {
    // In dry-run, count how many members have potential photos
    let potentialPhotos = 0;
    for (const { prepared } of toSync) {
      if (prepared.person_image_date) {
        potentialPhotos++;
      }
    }

    if (potentialPhotos > 0) {
      console.log('');
      console.log('Photos:');
      console.log(`  ${potentialPhotos} members have PersonImageDate set (potential photos)`);
    }

    console.log('');
    console.log('=== DRY RUN COMPLETE ===');
    console.log('Run with --import to actually sync these members.');
    console.log('Use --force to also update existing former members.');
    console.log('Use --skip-photos to skip photo download/upload.');
    return stats;
  }

  console.log('Syncing former members to Rondo Club...');
  console.log('');

  const syncStepId = tracker ? tracker.startStep('former-members-sync') : null;
  const dbForSync = openDb();
  try {
    for (let i = 0; i < toSync.length; i++) {
      const { knvb_id, prepared, rondo_club_id } = toSync[i];
      if (tracker) {
        tracker.updateStep(syncStepId, { current: i + 1, total: toSync.length, label: knvb_id });
      }

      try {
        let response;
        if (rondo_club_id) {
          // PUT to update existing person
          response = await rondoClubRequest(`wp/v2/people/${rondo_club_id}`, 'PUT', prepared.data, { verbose });
        } else {
          // POST to create new person
          response = await rondoClubRequest('wp/v2/people', 'POST', prepared.data, { verbose });
        }

        if (response.status >= 200 && response.status < 300) {
          const resultId = rondo_club_id || response.body.id;
          const sourceHash = computeSourceHash(knvb_id, prepared.data);

          // Track in rondo_club_members table
          upsertMembers(dbForSync, [{
            knvb_id: knvb_id,
            email: prepared.email,
            data_json: JSON.stringify(prepared.data),
            source_hash: sourceHash,
            person_image_date: prepared.person_image_date,
            last_seen_at: new Date().toISOString()
          }]);

          // Update sync state with rondo_club_id
          updateSyncState(dbForSync, knvb_id, sourceHash, resultId);

          stats.synced++;
          const action = rondo_club_id ? 'Updated' : 'Created';
          if (verbose) console.log(`  ✓ ${action} ${knvb_id} → Rondo Club post ${resultId}`);
        } else {
          stats.failed++;
          const errorMsg = `${response.status} ${JSON.stringify(response.body)}`;
          stats.errors.push({ knvb_id, error: errorMsg });
          console.error(`  ✗ Failed ${knvb_id}: ${errorMsg}`);
        }

        // Progress logging every 10 members
        if ((i + 1) % 10 === 0) {
          console.log(`Progress: ${i + 1}/${toSync.length} (${stats.synced} synced, ${stats.failed} failed)`);
        }

        // Rate limit: 0.5 second delay between requests
        if (i < toSync.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err) {
        stats.failed++;
        const errorMsg = err.message || String(err);
        stats.errors.push({ knvb_id, error: errorMsg });
        console.error(`  ✗ Failed ${knvb_id}: ${errorMsg}`);
      }
    }
  } finally {
    dbForSync.close();
    if (tracker) {
      tracker.endStep(syncStepId, {
        outcome: stats.failed > 0 ? (stats.synced > 0 ? 'partial' : 'failure') : 'success',
        created: stats.synced,
        failed: stats.failed,
        skipped: stats.skippedFormer
      });
    }
  }

  // Step 4: Download photos for former members
  if (!dryRun && !skipPhotos && stats.synced > 0) {
    console.log('');
    console.log('Downloading photos for former members...');
    console.log('');

    const photosDir = path.join(process.cwd(), 'photos');
    await fsp.mkdir(photosDir, { recursive: true });

    const dbForPhotos = openDb();
    try {
      // Get former members that were just synced (have person_image_date but need photos)
      const membersNeedingPhotos = getMembersByPhotoState(dbForPhotos, 'pending_download');

      if (membersNeedingPhotos.length === 0) {
        console.log('No former members need photo downloads.');
      } else {
        console.log(`${membersNeedingPhotos.length} former members need photo downloads`);

        const logDebug = createDebugLogger();
        const session = new SportlinkSession({
          logger: { log: console.log, verbose: verbose ? console.log : () => {}, error: console.error }
        });
        let page;

        try {
          // Login (or reuse cached session) before downloading photos
          try {
            page = await session.getPage();
            page.on('request', r => logDebug('>>', r.method(), r.url()));
            page.on('response', r => logDebug('<<', r.status(), r.url()));
          } catch (loginError) {
            console.log(`Sportlink login failed (${loginError.message.split('\n')[0]}) — skipping photo download`);
            stats.photos.failed = membersNeedingPhotos.length;
            await session.close();
            dbForPhotos.close();
            // Continue to Step 5
            console.log('');
            console.log('=== SUMMARY ===');
            console.log(`Downloaded: ${stats.downloaded}`);
            console.log(`To sync: ${stats.toSync}`);
            console.log(`Skipped (already exists): ${stats.skippedFormer}`);
            console.log(`Synced: ${stats.synced}`);
            console.log(`Failed: ${stats.failed}`);
            printPhotoStats(stats);
            if (tracker) tracker.endRun(stats.synced > 0 ? 'partial' : 'failure', stats);
            return stats;
          }

          const photoStepId = tracker ? tracker.startStep('former-members-photos-download') : null;
          let photoStepEnded = false;
          try {
          for (let i = 0; i < membersNeedingPhotos.length; i++) {
            const member = membersNeedingPhotos[i];
            if (verbose) console.log(`  Processing ${i + 1}/${membersNeedingPhotos.length}: ${member.knvb_id}`);
            if (tracker) {
              tracker.updateStep(photoStepId, { current: i + 1, total: membersNeedingPhotos.length, label: member.knvb_id });
            }

            try {
              const otherUrl = `https://club.sportlink.com/member/member-details/${member.knvb_id}/other`;

              // Set up MemberHeader promise BEFORE navigation
              const memberHeaderPromise = page.waitForResponse(
                resp => resp.url().includes('/member/MemberHeader?'),
                { timeout: 15000 }
              ).catch(() => null);

              if (verbose) console.log(`    Navigating to ${otherUrl}...`);
              await page.goto(otherUrl, { waitUntil: 'networkidle' });

              const memberHeaderResponse = await memberHeaderPromise;

              let memberHeaderData = null;
              if (memberHeaderResponse && memberHeaderResponse.ok()) {
                try {
                  memberHeaderData = await memberHeaderResponse.json();
                } catch (err) {
                  if (verbose) console.log(`    Error parsing MemberHeader: ${err.message}`);
                }
              }

              if (!memberHeaderData) {
                if (verbose) console.log(`    No MemberHeader response captured`);
                stats.photos.failed++;
                continue;
              }

              const headerResult = parseMemberHeaderResponse(memberHeaderData, member.knvb_id);

              if (!headerResult.photo_url) {
                if (verbose) console.log(`    No photo URL in MemberHeader`);
                stats.photos.noPhoto++;
                continue;
              }

              if (verbose) console.log(`    Downloading photo...`);
              const photoResult = await downloadPhotoFromUrl(headerResult.photo_url, member.knvb_id, photosDir, { verbose: (msg) => { if (verbose) console.log(msg); } });

              if (photoResult.permanent_error) {
                // Photo URL returns 404 — permanent error
                updatePhotoState(dbForPhotos, member.knvb_id, 'error');
                stats.photos.noPhoto++;
                if (verbose) console.log(`      Photo unavailable (404)`);
              } else if (photoResult.success) {
                updatePhotoState(dbForPhotos, member.knvb_id, 'downloaded');
                stats.photos.downloaded++;
                if (verbose) console.log(`      Saved ${path.basename(photoResult.path)} (${photoResult.bytes} bytes)`);
              } else {
                stats.photos.failed++;
              }
            } catch (error) {
              stats.photos.failed++;
              if (verbose) console.log(`    Error: ${error.message}`);
            }

            // Random delay between members
            if (i < membersNeedingPhotos.length - 1) {
              const delay = 500 + Math.random() * 1000;
              await new Promise(r => setTimeout(r, delay));
            }
          }
          } finally {
            if (tracker && !photoStepEnded) {
              photoStepEnded = true;
              tracker.endStep(photoStepId, {
                outcome: stats.photos.failed > 0 ? 'partial' : 'success',
                created: stats.photos.downloaded,
                skipped: stats.photos.noPhoto,
                failed: stats.photos.failed
              });
            }
          }
        } finally {
          await session.close();
        }

        console.log(`Downloaded ${stats.photos.downloaded} photos (${stats.photos.noPhoto} no photo, ${stats.photos.failed} failed)`);
      }
    } finally {
      dbForPhotos.close();
    }

    // Step 5: Upload photos to Rondo Club
    console.log('');
    console.log('Uploading photos to Rondo Club...');
    console.log('');

    const dbForUpload = openDb();
    try {
      const membersWithPhotos = getMembersByPhotoState(dbForUpload, 'downloaded');

      if (membersWithPhotos.length === 0) {
        console.log('No photos to upload.');
      } else {
        console.log(`${membersWithPhotos.length} photos to upload`);

        const uploadStepId = tracker ? tracker.startStep('former-members-photos-upload') : null;
        const uploadStartFailed = stats.photos.failed;
        try {
        for (let i = 0; i < membersWithPhotos.length; i++) {
          const member = membersWithPhotos[i];
          if (verbose) console.log(`  Uploading ${i + 1}/${membersWithPhotos.length}: ${member.knvb_id}`);
          if (tracker) {
            tracker.updateStep(uploadStepId, { current: i + 1, total: membersWithPhotos.length, label: member.knvb_id });
          }

          if (!member.rondo_club_id) {
            if (verbose) console.log(`    Skipped: no rondo_club_id`);
            continue;
          }

          // Find photo file
          const photoFile = await findPhotoFile(member.knvb_id, photosDir);
          if (!photoFile.found) {
            if (verbose) console.log(`    Skipped: photo file not found`);
            continue;
          }

          // Upload to Rondo Club
          try {
            await uploadPhotoToRondoClub(member.rondo_club_id, photoFile.path, verbose);
            updatePhotoState(dbForUpload, member.knvb_id, 'synced');
            stats.photos.uploaded++;
            if (verbose) console.log(`    Uploaded successfully`);
          } catch (error) {
            stats.photos.failed++;
            if (verbose) console.log(`    Upload failed: ${error.message}`);
          }

          // Rate limit: 2 seconds between uploads
          if (i < membersWithPhotos.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
        } finally {
          if (tracker) {
            const newFailures = stats.photos.failed - uploadStartFailed;
            tracker.endStep(uploadStepId, {
              outcome: newFailures > 0 ? 'partial' : 'success',
              updated: stats.photos.uploaded,
              failed: newFailures
            });
          }
        }

        console.log(`Uploaded ${stats.photos.uploaded} photos`);
      }
    } finally {
      dbForUpload.close();
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Downloaded: ${stats.downloaded}`);
  console.log(`To sync: ${stats.toSync}`);
  console.log(`Skipped (already exists): ${stats.skippedFormer}`);
  console.log(`Synced: ${stats.synced}`);
  console.log(`Failed: ${stats.failed}`);

  printPhotoStats(stats);

  if (stats.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    stats.errors.forEach(({ knvb_id, error }) => {
      console.log(`  - ${knvb_id}: ${error}`);
    });
  }

  if (tracker) {
    const outcome = stats.failed > 0 ? (stats.synced > 0 ? 'partial' : 'failure') : 'success';
    tracker.endRun(outcome, stats);
  }

  return stats;
}

/**
 * Print photo statistics section
 */
function printPhotoStats(stats) {
  if (stats.photos.downloaded > 0 || stats.photos.uploaded > 0 || stats.photos.noPhoto > 0 || stats.photos.failed > 0) {
    console.log('');
    console.log('Photos:');
    console.log(`  Downloaded: ${stats.photos.downloaded}`);
    console.log(`  Uploaded: ${stats.photos.uploaded}`);
    console.log(`  No photo: ${stats.photos.noPhoto}`);
    console.log(`  Failed: ${stats.photos.failed}`);
  }
}

/**
 * Find photo file for member by checking supported extensions
 * @param {string} knvbId - Member KNVB ID
 * @param {string} photosDir - Photos directory path
 * @returns {Promise<{found: boolean, path: string|null, ext: string|null}>}
 */
async function findPhotoFile(knvbId, photosDir) {
  const extensions = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

  for (const ext of extensions) {
    const filepath = path.join(photosDir, `${knvbId}.${ext}`);
    try {
      await fsp.access(filepath);
      return { found: true, path: filepath, ext };
    } catch {
      // File doesn't exist with this extension, continue
    }
  }

  return { found: false, path: null, ext: null };
}

/**
 * Upload photo to Rondo Club WordPress via multipart form-data
 * @param {number} rondoClubId - WordPress person post ID
 * @param {string} photoPath - Local path to photo file
 * @param {boolean} verbose - Verbose logging
 * @returns {Promise<void>}
 */
function uploadPhotoToRondoClub(rondoClubId, photoPath, verbose = false) {
  return new Promise((resolve, reject) => {
    const baseUrl = readEnv('RONDO_URL');
    const username = readEnv('RONDO_USERNAME');
    const password = readEnv('RONDO_APP_PASSWORD');

    if (!baseUrl || !username || !password) {
      reject(new Error('RONDO_URL, RONDO_USERNAME, and RONDO_APP_PASSWORD required in .env'));
      return;
    }

    const authString = `${username}:${password}`;
    const authHeader = `Basic ${Buffer.from(authString).toString('base64')}`;

    const parsedUrl = new URL(baseUrl);
    const fullPath = `/wp-json/rondo/v1/people/${rondoClubId}/photo`;

    if (verbose) console.log(`      POST ${fullPath}`);

    const form = new FormData();
    form.append('file', fs.createReadStream(photoPath));

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: fullPath,
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        ...form.getHeaders()
      },
      timeout: 30000
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          const error = new Error(`Rondo Club API error (${res.statusCode})`);
          error.details = data;
          reject(error);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout: Rondo Club API did not respond within 30 seconds'));
    });

    form.pipe(req);
  });
}

module.exports = { runImport };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--import');
  const verbose = args.includes('--verbose');
  const skipDownload = args.includes('--skip-download');
  const skipPhotos = args.includes('--skip-photos');
  const force = args.includes('--force');

  runImport({ dryRun, verbose, skipDownload, skipPhotos, force })
    .then(result => {
      if (result.failed > 0) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
