require('dotenv/config');

const { SportlinkSession } = require('../lib/sportlink-session');
const { createLoggerAdapter, createDebugLogger, isDebugEnabled } = require('../lib/log-adapters');

const LEGACY_ACTIVE_STATUS_SELECTOR = '#chipStatusACTIVE';
const MEMBER_STATUS_DROPDOWN_SELECTOR = '#dropdownMultiMemberStatus_styled';
const MEMBER_STATUS_OPTION_PREFIX = 'DROPDOWN_MULTISELECT_OPTION_';
const MEMBER_STATUS_OPTIONS = [
  'ACTIVE',
  'INACTIVE',
  'PROCESSING',
  'ELIGABLE_FOR_REMOVE',
  'REJECTED',
  'ASPIRANT'
];

function memberStatusOptionSelector(status) {
  return `input[name="${MEMBER_STATUS_OPTION_PREFIX}${status}"]`;
}

/** Select only inactive members across the legacy chip and current dropdown UIs. */
async function selectInactiveMemberStatus(page) {
  await page.waitForSelector('#btnShowMore:not([disabled])', { timeout: 20000 });
  await page.click('#btnShowMore');
  await page.waitForSelector(
    `${MEMBER_STATUS_DROPDOWN_SELECTOR}, ${LEGACY_ACTIVE_STATUS_SELECTOR}`,
    { timeout: 20000 }
  );

  if (await page.$(MEMBER_STATUS_DROPDOWN_SELECTOR)) {
    await page.click(MEMBER_STATUS_DROPDOWN_SELECTOR);
    await page.waitForSelector(memberStatusOptionSelector('INACTIVE'), { timeout: 20000 });

    for (const status of MEMBER_STATUS_OPTIONS) {
      const selector = memberStatusOptionSelector(status);
      const checked = await page.isChecked(selector);
      if (status === 'INACTIVE' && !checked) {
        await page.check(selector, { force: true });
      } else if (status !== 'INACTIVE' && checked) {
        await page.uncheck(selector, { force: true });
      }
    }

    await page.click('#btnApplydropdownMultiMemberStatus');
    return 'dropdown';
  }

  await page.click(LEGACY_ACTIVE_STATUS_SELECTOR);
  await page.click('#chipStatusELIGABLE_FOR_REMOVE');
  await page.click('#chipStatusINACTIVE');
  return 'chips';
}

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
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      const waitSeconds = Math.floor(Math.random() * 4) + 1; // Random between 1-5 seconds
      logDebug(`Waiting ${waitSeconds} seconds before clicking search button...`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));

      logVerbose('Toggling status filter to INACTIVE members...');

      const statusFilterUi = await selectInactiveMemberStatus(page);

      logVerbose(`Status filter toggled successfully to INACTIVE via ${statusFilterUi} UI`);

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
      if (session) {
        await session.close();
      }
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    logError('Error:', errorMsg);
    return { success: false, members: [], memberCount: 0, error: errorMsg };
  }
}

module.exports = { runDownloadInactive, selectInactiveMemberStatus };

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
