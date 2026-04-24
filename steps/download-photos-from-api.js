require('dotenv/config');

const { chromium } = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { openDb, getMembersNeedingPhotoDownload, updatePhotoState } = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');
const { loginToSportlink } = require('../lib/sportlink-login');
const { createDebugLogger } = require('../lib/log-adapters');
const { parseMemberHeaderResponse, downloadPhotoFromUrl } = require('../lib/photo-utils');

/**
 * Photo download step.
 *
 * Launches Playwright, logs into Sportlink, visits /other tab for each member
 * with pending_download photo state, captures MemberHeader response for the
 * signed photo URL, and downloads the photo immediately.
 *
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {Object} [options.page] - Shared Playwright page (already logged in). If provided, skips browser launch and login.
 */
async function runPhotoDownload(options = {}) {
  const { logger: providedLogger, verbose = false, page: sharedPage } = options;
  const logger = providedLogger || createSyncLogger({ verbose });

  const result = {
    success: true,
    total: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  const db = openDb();
  try {
    const members = getMembersNeedingPhotoDownload(db);
    result.total = members.length;

    if (members.length === 0) {
      logger.log('No photos pending download');
      return result;
    }

    logger.log(`${members.length} photos pending download`);

    // Ensure photos directory exists
    const photosDir = path.join(process.cwd(), 'photos');
    await fs.mkdir(photosDir, { recursive: true });

    const ownsBrowser = !sharedPage;
    const logDebug = createDebugLogger();
    let browser;
    let page;

    if (sharedPage) {
      page = sharedPage;
    } else {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
      });
      page = await context.newPage();

      page.on('request', r => logDebug('>>', r.method(), r.url()));
      page.on('response', r => logDebug('<<', r.status(), r.url()));
    }

    try {
      if (!sharedPage) {
        try {
          await loginToSportlink(page, { logger });
        } catch (loginError) {
          logger.log(`Sportlink login failed (${loginError.message.split('\n')[0]}) — skipping photo download`);
          result.warning = `Login failed: ${loginError.message.split('\n')[0]}`;
          return result;
        }
      }

      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        logger.verbose(`Processing ${i + 1}/${members.length}: ${member.knvb_id}`);

        try {
          const otherUrl = `https://club.sportlink.com/member/member-details/${member.knvb_id}/other`;

          // Set up MemberHeader promise BEFORE navigation
          const memberHeaderPromise = page.waitForResponse(
            resp => resp.url().includes('/member/MemberHeader?'),
            { timeout: 15000 }
          ).catch(() => null);

          logger.verbose(`  Navigating to ${otherUrl}...`);
          await page.goto(otherUrl, { waitUntil: 'networkidle' });

          const memberHeaderResponse = await memberHeaderPromise;

          let memberHeaderData = null;
          if (memberHeaderResponse && memberHeaderResponse.ok()) {
            try {
              memberHeaderData = await memberHeaderResponse.json();
            } catch (err) {
              logger.verbose(`  Error parsing MemberHeader: ${err.message}`);
            }
          }

          if (!memberHeaderData) {
            logger.verbose(`  No MemberHeader response captured`);
            result.failed++;
            result.errors.push({ knvb_id: member.knvb_id, message: 'No MemberHeader response' });
            continue;
          }

          const headerResult = parseMemberHeaderResponse(memberHeaderData, member.knvb_id);

          if (!headerResult.photo_url) {
            logger.verbose(`  No photo URL in MemberHeader`);
            result.failed++;
            result.errors.push({ knvb_id: member.knvb_id, message: 'No photo URL in MemberHeader' });
            continue;
          }

          logger.verbose(`  Downloading photo...`);
          const photoResult = await downloadPhotoFromUrl(headerResult.photo_url, member.knvb_id, photosDir, logger);

          if (photoResult.permanent_error) {
            // Photo URL returns 404 "Not Found" — this is permanent, not an error
            updatePhotoState(db, member.knvb_id, 'error');
            result.skipped++;
            logger.verbose(`    Photo unavailable (404) — marked as permanent error, will retry if PersonImageDate changes`);
          } else if (photoResult.success) {
            updatePhotoState(db, member.knvb_id, 'downloaded');
            result.downloaded++;
            logger.verbose(`    Saved ${path.basename(photoResult.path)} (${photoResult.bytes} bytes)`);
          } else {
            result.failed++;
            result.errors.push({ knvb_id: member.knvb_id, message: 'Photo download failed' });
          }
        } catch (error) {
          result.failed++;
          result.errors.push({ knvb_id: member.knvb_id, message: error.message });
          logger.verbose(`  Error: ${error.message}`);
        }

        // Random delay between members to avoid rate limiting
        if (i < members.length - 1) {
          const delay = 500 + Math.random() * 1000;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    } finally {
      if (ownsBrowser && browser) {
        await browser.close();
      }
    }

    // Summary
    logger.log(`Photos: ${result.downloaded} downloaded, ${result.skipped} unavailable, ${result.failed} failed (${result.total} total)`);
    if (result.errors.length > 0) {
      result.success = false;
    }

    return result;
  } finally {
    db.close();
  }
}

module.exports = { runPhotoDownload };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  runPhotoDownload({ verbose })
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
