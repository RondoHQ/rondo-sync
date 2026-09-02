/**
 * Shared Sportlink browser session manager.
 *
 * Two layers of reuse:
 *
 *   1. In-process — one SportlinkSession instance shares a single browser +
 *      page across multiple pipeline steps within the same Node process.
 *      Pipelines that orchestrate multiple Sportlink-touching steps create
 *      one session at the top and pass `await session.getPage()` to each.
 *
 *   2. Cross-process — `getPage()` first tries to reuse a Playwright
 *      `storageState` (cookies + localStorage) persisted to disk by a
 *      previous run. If the cached state still authenticates, the OTP login
 *      dance is skipped entirely. This matters because every sync (reverse,
 *      player-history, functions, teams, ...) lives in its own Node process
 *      launched by cron — without the disk cache, every cron tick re-does
 *      a 30–60s OTP login and the shared TOTP secret becomes a contention
 *      point when multiple syncs overlap.
 *
 *   Refresh coordination uses an O_EXCL lock file so concurrent processes
 *   that all find the cached state expired don't pile new logins onto
 *   Sportlink simultaneously — the first to acquire the lock refreshes
 *   and persists; the rest pick up the fresh state.
 *
 * Usage in a pipeline:
 *
 *   const { SportlinkSession } = require('../lib/sportlink-session');
 *   const session = new SportlinkSession({ logger, verbose });
 *
 *   try {
 *     const page = await session.getPage();  // logs in only if cache invalid
 *     await runDownload({ page, logger, verbose });
 *     await runPhotoDownload({ page: await session.getPage(), logger, verbose });
 *   } finally {
 *     await session.close();
 *   }
 *
 * Single-shot ergonomics: `await SportlinkSession.withPage(opts, async (page) => { ... })`
 * handles open/close for callers that just need one page.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { chromium } = require('playwright');
const { loginToSportlink } = require('./sportlink-login');
const { isSportlinkAuthUrl } = require('./sportlink-auth');
const { createDebugLogger, isDebugEnabled } = require('./log-adapters');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

const STATE_FILE = path.join(process.cwd(), 'data', 'sportlink-storage-state.json');
const LOCK_FILE = path.join(process.cwd(), 'data', 'sportlink-storage-state.lock');

// Hard ceiling — refresh the cached session at least this often even if it
// still appears valid. Sportlink/Keycloak refresh-token lifetime is undocumented;
// 6h keeps things fresh without forcing the OTP dance every cron tick.
const MAX_SESSION_AGE_MS = 6 * 60 * 60 * 1000;

// If another process refreshed the cache while we were waiting on the lock,
// reuse their result instead of re-logging in.
const RECENT_REFRESH_WINDOW_MS = 60 * 1000;

// Probe URL — Sportlink redirects to its identity provider when
// unauthenticated, so we can tell whether cached cookies still work.
const PROBE_URL = 'https://club.sportlink.com/';

class SportlinkSession {
  /**
   * @param {Object} options
   * @param {Object} [options.logger] - Logger with log(), verbose(), error()
   * @param {boolean} [options.verbose=false] - Verbose mode
   * @param {boolean} [options.acceptDownloads=true] - Enable downloads in context
   * @param {boolean} [options.useStorageCache=true] - Reuse persisted login across processes
   */
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.verbose = options.verbose || false;
    this.acceptDownloads = options.acceptDownloads !== false;
    this.useStorageCache = options.useStorageCache !== false;

    this._browser = null;
    this._context = null;
    this._page = null;
    this._loggedIn = false;
    this._loginCount = 0;
    this._reusedFromCache = false;
  }

  /**
   * Get (or create) the shared Playwright page. On first call this either
   * reuses a cached on-disk Sportlink session or performs a full OTP login,
   * persisting the resulting storage state for sibling processes.
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async getPage() {
    if (this._page && !this._page.isClosed()) {
      return this._page;
    }

    const logDebug = createDebugLogger();

    this.logger?.verbose('Launching shared Sportlink browser session...');
    this._browser = await this._launchBrowser();

    try {
      if (isDebugEnabled()) {
        // Wire debug handler to whatever page we end up with below.
        this._debugLog = logDebug;
      }

      // Try cached path first.
      if (this.useStorageCache) {
        const cached = await loadCachedState();
        if (cached) {
          const ok = await this._tryReuse(cached);
          if (ok) {
            this._reusedFromCache = true;
            this._loggedIn = true;
            return this._page;
          }
        }

        // Cache miss or expired — coordinate refresh with other processes.
        await acquireLock(this.logger);
        try {
          // Re-check after the lock: a sibling process may have just refreshed.
          const justRefreshed = await loadCachedState({ maxAgeMs: RECENT_REFRESH_WINDOW_MS });
          if (justRefreshed) {
            const ok = await this._tryReuse(justRefreshed);
            if (ok) {
              this.logger?.verbose('Reused freshly-refreshed Sportlink session from sibling process');
              this._reusedFromCache = true;
              this._loggedIn = true;
              return this._page;
            }
          }
          await this._openContextAndLogin();
          await saveState(this._context, this.logger);
        } finally {
          await releaseLock();
        }
      } else {
        await this._openContextAndLogin();
      }

      return this._page;
    } catch (error) {
      // A login or context failure happens before most callers enter their own
      // try/finally. Close here so Chromium cannot keep Node, sync.sh, and the
      // per-pipeline flock alive indefinitely.
      await this.close();
      throw error;
    }
  }

  /** @private */
  async _launchBrowser() {
    return chromium.launch({ headless: true });
  }

  /**
   * Force a re-login on the existing page (e.g., after a downstream 401).
   * Persists the new storage state for sibling processes.
   */
  async relogin() {
    if (!this._page || this._page.isClosed()) {
      await this.getPage();
      return;
    }
    await acquireLock(this.logger);
    try {
      // Drop the existing context's cookies first. A *partially*-valid session
      // (cookies present but token scope insufficient) keeps Sportlink
      // authenticated on '/', so loginToSportlink's navigate-to-root silently
      // redirects to /dashboard and the #username form never renders — a 45s
      // waitForSelector timeout. invalidateCachedSession() only clears the disk
      // cache, not the live context, so clear it here to force Keycloak to
      // present the login form. Harmless on the post-401 path (cookies dead).
      if (this._context) {
        await this._context.clearCookies().catch(() => {});
      }
      await this._login();
      if (this.useStorageCache) {
        await saveState(this._context, this.logger);
      }
    } finally {
      await releaseLock();
    }
  }

  /**
   * Close the browser session. Idempotent.
   */
  async close() {
    if (this._browser) {
      try {
        await this._browser.close();
      } catch {
        // ignore
      }
      this._browser = null;
      this._context = null;
      this._page = null;
      this._loggedIn = false;
    }
  }

  /** @returns {boolean} */
  get isActive() {
    return this._browser !== null && this._page !== null && !this._page.isClosed();
  }

  /** @returns {number} */
  get loginCount() {
    return this._loginCount;
  }

  /** @returns {boolean} True iff the current session was loaded from disk cache (no login this run). */
  get reusedFromCache() {
    return this._reusedFromCache;
  }

  /**
   * Single-shot convenience: open a session, run fn, close. Cleans up even
   * on throw. Returns whatever fn returns.
   *
   * @template T
   * @param {Object} options - Same as constructor.
   * @param {(page: import('playwright').Page, session: SportlinkSession) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  static async withPage(options, fn) {
    const session = new SportlinkSession(options);
    try {
      const page = await session.getPage();
      return await fn(page, session);
    } finally {
      await session.close();
    }
  }

  /** @private */
  async _openContextAndLogin() {
    this._context = await this._browser.newContext({
      acceptDownloads: this.acceptDownloads,
      userAgent: DEFAULT_USER_AGENT
    });
    this._page = await this._context.newPage();
    this._wireDebug();
    this.logger?.verbose('Cached Sportlink session missing/expired — logging in fresh');
    await this._login();
  }

  /** @private */
  async _tryReuse(storageState) {
    let context = null;
    try {
      context = await this._browser.newContext({
        acceptDownloads: this.acceptDownloads,
        userAgent: DEFAULT_USER_AGENT,
        storageState
      });
      const page = await context.newPage();
      try {
        await page.goto(PROBE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (err) {
        this.logger?.verbose(`Cached session probe navigation failed: ${err.message}`);
        await context.close().catch(() => {});
        return false;
      }
      const onAuthDomain = isSportlinkAuthUrl(page.url());
      const loginFormVisible = onAuthDomain
        ? true
        : Boolean(await page.$('#username').catch(() => null));
      if (onAuthDomain || loginFormVisible) {
        this.logger?.verbose('Cached Sportlink session probe redirected to login');
        await context.close().catch(() => {});
        return false;
      }
      this._context = context;
      this._page = page;
      this._wireDebug();
      this.logger?.verbose('Reused cached Sportlink session (no login needed)');
      return true;
    } catch (err) {
      this.logger?.verbose(`Cached session reuse failed: ${err.message}`);
      if (context) await context.close().catch(() => {});
      return false;
    }
  }

  /** @private */
  _wireDebug() {
    if (!this._debugLog || !this._page) return;
    this._page.on('request', (r) => this._debugLog('>>', r.method(), r.url()));
    this._page.on('response', (r) => this._debugLog('<<', r.status(), r.url()));
  }

  /** @private */
  async _login() {
    const loggerAdapter = this.logger
      ? {
          log: (...a) => this.logger.log(...a),
          verbose: (...a) => this.logger.verbose(...a),
          error: (...a) => this.logger.error(...a)
        }
      : undefined;
    await loginToSportlink(this._page, { logger: loggerAdapter });
    this._loggedIn = true;
    this._loginCount++;
    if (this._loginCount > 1) {
      this.logger?.verbose(`Sportlink re-login successful (login #${this._loginCount})`);
    } else {
      this.logger?.verbose('Sportlink login successful');
    }
  }
}

/**
 * Drop the cached storage state so the next session forces a fresh login.
 * Use when a downstream call sees a hard 401 / token-expired error.
 */
async function invalidateCachedSession() {
  await fsp.unlink(STATE_FILE).catch(() => {});
}

// ---------- internal helpers ----------

async function loadCachedState({ maxAgeMs = MAX_SESSION_AGE_MS } = {}) {
  try {
    const stat = await fsp.stat(STATE_FILE);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveState(context, logger) {
  try {
    await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    const state = await context.storageState();
    await fsp.writeFile(STATE_FILE, JSON.stringify(state), { mode: 0o600 });
    await fsp.chmod(STATE_FILE, 0o600);
    logger?.verbose('Persisted Sportlink session to disk');
  } catch (err) {
    logger?.error?.(`Could not persist Sportlink session: ${err.message}`);
  }
}

async function acquireLock(logger) {
  const start = Date.now();
  const timeoutMs = 120 * 1000;
  const staleMs = 180 * 1000;
  while (Date.now() - start < timeoutMs) {
    try {
      // O_EXCL — fails atomically if the file already exists.
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const stat = await fsp.stat(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > staleMs) {
          logger?.verbose('Removing stale Sportlink session lock');
          await fsp.unlink(LOCK_FILE).catch(() => {});
          continue;
        }
      } catch {
        // race: file vanished while we statted it; loop and retry the openSync
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error('Timed out waiting for Sportlink session lock');
}

async function releaseLock() {
  await fsp.unlink(LOCK_FILE).catch(() => {});
}

module.exports = {
  SportlinkSession,
  invalidateCachedSession,
  STATE_FILE
};
