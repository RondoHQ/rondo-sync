require('dotenv/config');

const { openDb, insertSportlinkRun } = require('../lib/laposta-db');
const { SportlinkSession } = require('../lib/sportlink-session');
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

  // When a shared page is provided, skip browser launch and login.
  // Otherwise acquire an authenticated page from SportlinkSession, which
  // reuses a cached login across processes when possible.
  let session;
  try {
    let page;
    if (sharedPage) {
      page = sharedPage;
    } else {
      session = new SportlinkSession({
        logger: { log, verbose: logVerbose, error: logError }
      });
      page = await session.getPage();
    }

    try {
      if (!sharedPage && isDebugEnabled()) {
        page.on('request', r => logDebug('>>', r.method(), r.url()));
        page.on('response', r => logDebug('<<', r.status(), r.url()));
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

      // Sportlink returns 500 for empty searches, so search a-z and merge results.
      // If a single letter fails, expand it to letter+vowel combinations.
      const vowels = ['a', 'e', 'i', 'o', 'u'];
      const terms = 'abcdefghijklmnopqrstuvwxyz'.split('');
      const allMembersMap = new Map();
      let successCount = 0;
      let errorCount = 0;

      const setupSearchPage = async () => {
        await page.goto(memberSearchPageUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle');
        await page.waitForSelector('#btnShowMore', { timeout: 20000 });
        await page.click('#btnShowMore');
        await page.waitForSelector('#scFetchUnionTeams_input', { timeout: 20000 });
        await page.check('#scFetchUnionTeams_input');
      };

      for (const term of terms) {
        try {
          logVerbose(`Searching for: "${term}"`);
          await page.fill('input[name="SEARCHVALUE"]', term);

          const responsePromise = page.waitForResponse(
            resp => resp.url().includes('/navajo/entity/common/clubweb/member/search/SearchMembers') && resp.request().method() === 'POST',
            { timeout: 60000 }
          );

          await page.click('#btnSearch');
          const response = await responsePromise;
          logDebug(`"${term}" response: ${response.status()}`);

          if (!response.ok()) {
            logError(`Search for "${term}" failed: ${response.status()}`);
            if (term.length === 1) terms.push(...vowels.map(v => term + v));
            errorCount++;
            await setupSearchPage();
            continue;
          }

          const jsonData = await response.json();
          for (const member of (jsonData.Members || [])) {
            const key = member.PublicPersonId;
            if (key && !allMembersMap.has(key)) allMembersMap.set(key, member);
          }
          successCount++;
        } catch (termErr) {
          logError(`Error searching for "${term}": ${termErr.message}`);
          if (term.length === 1) terms.push(...vowels.map(v => term + v));
          errorCount++;
          try {
            await setupSearchPage();
          } catch (recoveryErr) {
            logError(`Recovery failed after "${term}": ${recoveryErr.message}`);
            break;
          }
        }
      }

      if (successCount === 0) {
        const errorMsg = `All ${terms.length} searches failed`;
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

      log(`Downloaded ${memberCount} members from Sportlink (${successCount} searches OK, ${errorCount} failed/expanded)`);
      return { success: true, memberCount };
    } finally {
      if (session) {
        await session.close();
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
