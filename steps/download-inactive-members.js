require('dotenv/config');

const { chromium } = require('playwright');
const { loginToSportlink } = require('../lib/sportlink-login');
const { createLoggerAdapter, createDebugLogger, isDebugEnabled } = require('../lib/log-adapters');

/**
 * Download inactive member data from Sportlink
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {Object} [options.page] - Shared Playwright page (already logged in). If provided, skips browser launch and login.
 * @returns {Promise<{success: boolean, members: Array, memberCount: number, error?: string}>}
 */
async function runDownloadInactive(options = {}) {
  const { logger, verbose = false, page: sharedPage } = options;

  const { log, verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const logDebug = createDebugLogger();

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

      logVerbose('Toggling status filter to INACTIVE members...');

      await page.click('#btnShowMore');
      await page.waitForSelector('#chipStatusACTIVE', { timeout: 20000 });
      await page.click('#chipStatusACTIVE');
      await page.click('#chipStatusELIGABLE_FOR_REMOVE');
      await page.click('#chipStatusINACTIVE');

      logVerbose('Status filter toggled successfully to INACTIVE');

      // Set up listener for the SearchMembers POST response before clicking
      logDebug('Setting up response listener for SearchMembers POST request...');
      const responsePromise = page.waitForResponse(
        resp => resp.url().includes('/navajo/entity/common/clubweb/member/search/SearchMembers') && resp.request().method() === 'POST',
        { timeout: 60000 } // 60 seconds timeout for long-running search requests
      );

      logDebug('Clicking search button: #btnSearch');
      await page.click('#btnSearch');

      const response = await responsePromise;
      logDebug('Search response received. Status:', response.status(), response.statusText());
      logDebug('Search response headers:', JSON.stringify(response.headers(), null, 2));

      if (!response.ok()) {
        let errorBody = '';
        try {
          errorBody = await response.text();
          logDebug('Search response body:', errorBody);
        } catch (e) {
          logDebug('Could not read response body:', e.message);
        }
        const errorMsg = `Search request failed (${response.status()} ${response.statusText()}): ${errorBody || 'No error details'}`;
        logError('Search request failed:');
        logError('  URL:', response.url());
        logError('  Status:', response.status(), response.statusText());
        logError('  Response body:', errorBody || '(empty)');
        return { success: false, members: [], memberCount: 0, error: errorMsg };
      }

      const jsonData = await response.json();
      const members = Array.isArray(jsonData.Members) ? jsonData.Members : [];
      const memberCount = members.length;

      log(`Downloaded ${memberCount} inactive members from Sportlink`);
      return { success: true, members, memberCount };
    } finally {
      if (ownsBrowser && browser) {
        await browser.close();
      }
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error:', errorMsg);
    return { success: false, members: [], memberCount: 0, error: errorMsg };
  }
}

module.exports = { runDownloadInactive };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  runDownloadInactive({ verbose })
    .then(result => {
      if (!result.success) process.exitCode = 1;
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
