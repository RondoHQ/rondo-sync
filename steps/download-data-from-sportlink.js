require('dotenv/config');

const { chromium } = require('playwright');
const { openDb, insertSportlinkRun } = require('../lib/laposta-db');
const { loginToSportlink } = require('../lib/sportlink-login');
const { createLoggerAdapter, createDebugLogger, isDebugEnabled } = require('../lib/log-adapters');

/**
 * Download member data from Sportlink
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode (creates logger if not provided)
 * @param {Object} [options.page] - Shared Playwright page (already logged in). If provided, skips browser launch and login.
 * @returns {Promise<{success: boolean, memberCount: number, error?: string}>}
 */
async function runDownload(options = {}) {
  const { logger, verbose = false, page: sharedPage } = options;

  const { log, verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const logDebug = createDebugLogger();

  // When a shared page is provided, skip browser launch and login
  const ownsBrowser = !sharedPage;
  let browser;
  try {
    let page;
    if (sharedPage) {
      page = sharedPage;
    } else {
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({
        acceptDownloads: true,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
      });
      page = await context.newPage();
    }

    try {
      if (!sharedPage && isDebugEnabled()) {
        page.on('request', r => logDebug('>>', r.method(), r.url()));
        page.on('response', r => logDebug('<<', r.status(), r.url()));
      }

      if (!sharedPage) {
        await loginToSportlink(page, { logger: { log, verbose: logVerbose, error: logError } });
      }

      const memberSearchPageUrl = 'https://club.sportlink.com/member/search';
      logDebug('Navigating to member search page:', memberSearchPageUrl);
      await page.goto(memberSearchPageUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle');

      const waitSeconds = Math.floor(Math.random() * 4) + 1; // Random between 1-5 seconds
      logDebug(`Waiting ${waitSeconds} seconds before clicking search button...`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));

      logDebug('Clicking show more button: #btnShowMore');
      await page.waitForSelector('#btnShowMore', { timeout: 20000 });
      await page.click('#btnShowMore');

      logDebug('Checking union teams checkbox: #scFetchUnionTeams_input');
      await page.waitForSelector('#scFetchUnionTeams_input', { timeout: 20000 });
      await page.check('#scFetchUnionTeams_input');

      // Sportlink returns 500 for empty searches, so search a-z and merge results
      const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
      const allMembersMap = new Map();
      let searchErrors = 0;

      for (const letter of letters) {
        logVerbose(`Searching for letter: ${letter}`);
        await page.fill('input[name="SEARCHVALUE"]', letter);

        const responsePromise = page.waitForResponse(
          resp => resp.url().includes('/navajo/entity/common/clubweb/member/search/SearchMembers') && resp.request().method() === 'POST',
          { timeout: 60000 }
        );

        await page.click('#btnSearch');
        const response = await responsePromise;
        logDebug(`Letter "${letter}" response: ${response.status()}`);

        if (!response.ok()) {
          logError(`Search for "${letter}" failed: ${response.status()}`);
          searchErrors++;
          continue;
        }

        const jsonData = await response.json();
        for (const member of (jsonData.Members || [])) {
          const key = member.PublicPersonId;
          if (key && !allMembersMap.has(key)) {
            allMembersMap.set(key, member);
          }
        }
      }

      if (searchErrors === letters.length) {
        const errorMsg = `All ${letters.length} letter searches failed`;
        logError(errorMsg);
        return { success: false, memberCount: 0, error: errorMsg };
      }

      const mergedMembers = Array.from(allMembersMap.values());
      const memberCount = mergedMembers.length;
      const db = openDb();
      try {
        insertSportlinkRun(db, JSON.stringify({ Members: mergedMembers }));
      } finally {
        db.close();
      }

      log(`Downloaded ${memberCount} members from Sportlink (${letters.length - searchErrors}/${letters.length} letter searches succeeded)`);
      return { success: true, memberCount };
    } finally {
      if (ownsBrowser && browser) {
        await browser.close();
      }
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error:', errorMsg);
    return { success: false, memberCount: 0, error: errorMsg };
  }
}

module.exports = { runDownload };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  runDownload({ verbose })
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
