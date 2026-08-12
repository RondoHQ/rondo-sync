require('dotenv/config');

const fs = require('fs/promises');
const path = require('path');
const { openDb, insertSportlinkRun } = require('../lib/laposta-db');
const { SportlinkSession, invalidateCachedSession } = require('../lib/sportlink-session');
const { createLoggerAdapter, createDebugLogger, isDebugEnabled } = require('../lib/log-adapters');

/**
 * Save a screenshot + HTML snapshot of the current page to debug/, named with
 * the supplied label and a UTC timestamp. Used when a selector wait fails so
 * we can see what Sportlink actually rendered (e.g. a session-expired modal
 * intercepting #btnShowMore). Returns the paths it wrote, or null on failure.
 */
async function captureSportlinkDebug(page, label, log) {
  try {
    const debugDir = path.join(process.cwd(), 'debug');
    await fs.mkdir(debugDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(debugDir, `${label}-${ts}`);
    const url = page.url();
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const html = await page.content();
    await fs.writeFile(`${base}.html`, html, 'utf8');
    log(`Saved Sportlink debug snapshot for ${label} at URL ${url}: ${base}.png + ${base}.html`);
    return { png: `${base}.png`, html: `${base}.html`, url };
  } catch (captureErr) {
    log(`Could not save Sportlink debug snapshot for ${label}: ${captureErr.message}`);
    return null;
  }
}

/**
 * Download member data from Sportlink
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {boolean} [options.verbose=false] - Verbose mode (creates logger if not provided)
 * @param {Object} [options.page] - Shared Playwright page (already logged in). If provided, skips browser launch and login.
 * @param {Object} [options.session] - The SportlinkSession that owns the shared page. Pass this alongside `page`
 *   so the stale-session → /dashboard self-heal (relogin + retry) works on the pipeline path, not only standalone.
 * @returns {Promise<{success: boolean, memberCount: number, error?: string}>}
 */
async function runDownload(options = {}) {
  const { logger, verbose = false, page: sharedPage, session: sharedSession } = options;

  const { log, verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const logDebug = createDebugLogger();

  // When a shared page is provided, skip browser launch and login.
  // Otherwise acquire an authenticated page from SportlinkSession, which
  // reuses a cached login across processes when possible.
  // When a shared page is provided, the caller (pipeline) also owns the session;
  // accept it via `sharedSession` so we can relogin on a stale-session redirect.
  let session = sharedSession;
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

      // Navigate to the member-search page, then verify we actually landed on
      // it. A partially-valid cached session (cookies present but token scope
      // insufficient) silently 30x-redirects to /dashboard, where the rest of
      // this step waits 20s for a #btnShowMore that's not there.
      // Diagnosed 2026-05-29: SportlinkSession._tryReuse only probes the root
      // URL, so it doesn't catch this. If we detect the redirect, invalidate
      // the cached state, force a fresh login, and try once more.
      const navigateToSearch = async () => {
        logDebug('Navigating to member search page:', memberSearchPageUrl);
        await page.goto(memberSearchPageUrl, { waitUntil: 'domcontentloaded' });
        // Best-effort settle only. Sportlink's SPA keeps background network
        // activity going, so 'networkidle' intermittently never fires and the
        // default 30s timeout hard-fails the whole download (3/5 runs on
        // 2026-08-12). domcontentloaded above is enough to proceed; the search
        // panel has its own #btnShowMore:not([disabled]) reload-retry. Bound it
        // and swallow the timeout, matching download-functions/reverse-sync.
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      };

      await navigateToSearch();

      // A partially-valid cached session lands on /dashboard instead of
      // /member/search. Self-heal by re-logging in — works on both the
      // standalone path (session created above) and the pipeline path
      // (session passed in via `sharedSession`). Previously gated behind
      // `!sharedPage`, which left the 4x-daily people pipeline unable to
      // recover and dying on a 20s #btnShowMore timeout (the first run of
      // the day, when the cached session had gone stale overnight).
      if (session && !page.url().includes('/member/search')) {
        logError(`Sportlink redirected /member/search → ${page.url()} — cached session is stale. Invalidating and re-logging in.`);
        await captureSportlinkDebug(page, 'sportlink-stale-session-pre-relogin', logError);
        await invalidateCachedSession();
        await session.relogin();
        page = await session.getPage();
        await navigateToSearch();
      }

      const waitSeconds = Math.floor(Math.random() * 4) + 1; // Random between 1-5 seconds
      logDebug(`Waiting ${waitSeconds} seconds before clicking search button...`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));

      // Open the advanced-search panel (#btnShowMore reveals the union-teams
      // checkbox + search field). The button renders visible but occasionally
      // stays `disabled` (data-test-disabled="true") for 30s+ while the
      // member-search component initialises slowly — a plain click() then times
      // out on "element is not enabled" and fails the whole download (seen
      // 2026-04-24 and 2026-06-09). So gate on the *enabled* state, and on
      // failure reload-retry, since a fresh page load clears the stuck state.
      const openAdvancedSearch = async ({ renavigate = false } = {}) => {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            if (renavigate || attempt > 1) await navigateToSearch();
            logDebug(`Opening advanced search (#btnShowMore), attempt ${attempt}/${MAX_ATTEMPTS}`);
            // `:not([disabled])` only matches once the button is enabled, so
            // waitForSelector blocks on enablement rather than mere visibility.
            await page.waitForSelector('#btnShowMore:not([disabled])', { timeout: 20000 });
            await page.click('#btnShowMore');
            await page.waitForSelector('#scFetchUnionTeams_input', { timeout: 20000 });
            await page.check('#scFetchUnionTeams_input');
            return;
          } catch (err) {
            logError(`Advanced-search open attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
            if (attempt === MAX_ATTEMPTS) {
              await captureSportlinkDebug(page, 'sportlink-btnShowMore-initial', logError);
              throw err;
            }
            await page.waitForTimeout(2000);
          }
        }
      };

      await openAdvancedSearch();

      // Sportlink returns 500 for empty searches, so search a-z and merge results.
      // If a single letter fails, expand it to letter+vowel combinations.
      const vowels = ['a', 'e', 'i', 'o', 'u'];
      const terms = 'abcdefghijklmnopqrstuvwxyz'.split('');
      const allMembersMap = new Map();
      let successCount = 0;
      let errorCount = 0;

      // Per-term recovery: re-navigate and re-open the advanced-search panel
      // (same reload-retry + enabled-gating as the initial open).
      const setupSearchPage = () => openAdvancedSearch({ renavigate: true });

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
