/**
 * Shared Sportlink browser session manager.
 *
 * Allows multiple pipeline steps to reuse a single Playwright browser
 * session (and Sportlink login) instead of each step launching its own
 * browser and performing a separate OTP login.
 *
 * Usage in a pipeline:
 *
 *   const { SportlinkSession } = require('../lib/sportlink-session');
 *   const session = new SportlinkSession({ logger, verbose });
 *
 *   try {
 *     // Step 1 — gets browser + page, logs in on first call
 *     const page = await session.getPage();
 *     await runDownload({ page, logger, verbose });
 *
 *     // Step 2 — reuses the same page (no re-login)
 *     await runPhotoDownload({ page: await session.getPage(), logger, verbose });
 *   } finally {
 *     await session.close();
 *   }
 *
 * Each step can also still be run standalone (launching its own browser)
 * by NOT passing a page option — backward compatible.
 */

const { chromium } = require('playwright');
const { loginToSportlink } = require('./sportlink-login');
const { createDebugLogger, isDebugEnabled } = require('./log-adapters');

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

class SportlinkSession {
  /**
   * @param {Object} options
   * @param {Object} [options.logger] - Logger instance with log(), verbose(), error()
   * @param {boolean} [options.verbose=false] - Verbose mode
   * @param {boolean} [options.acceptDownloads=true] - Enable downloads in browser context
   */
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.verbose = options.verbose || false;
    this.acceptDownloads = options.acceptDownloads !== false;

    this._browser = null;
    this._context = null;
    this._page = null;
    this._loggedIn = false;
    this._loginCount = 0;
  }

  /**
   * Get (or create) the shared Playwright page.
   * Launches browser and logs in to Sportlink on first call.
   * Subsequent calls return the same page without re-login.
   *
   * @returns {Promise<import('playwright').Page>}
   */
  async getPage() {
    if (this._page && !this._page.isClosed()) {
      return this._page;
    }

    const logDebug = createDebugLogger();

    this.logger?.verbose('Launching shared Sportlink browser session...');

    this._browser = await chromium.launch({ headless: true });
    this._context = await this._browser.newContext({
      acceptDownloads: this.acceptDownloads,
      userAgent: DEFAULT_USER_AGENT
    });
    this._page = await this._context.newPage();

    if (isDebugEnabled()) {
      this._page.on('request', r => logDebug('>>', r.method(), r.url()));
      this._page.on('response', r => logDebug('<<', r.status(), r.url()));
    }

    await this._login();

    return this._page;
  }

  /**
   * Re-login to Sportlink using the existing page.
   * Useful when a step encounters a session timeout.
   *
   * @returns {Promise<void>}
   */
  async relogin() {
    if (!this._page || this._page.isClosed()) {
      // Session was closed — getPage() will create a new one
      await this.getPage();
      return;
    }

    await this._login();
  }

  /**
   * Close the browser session.
   * Safe to call multiple times.
   */
  async close() {
    if (this._browser) {
      try {
        await this._browser.close();
      } catch (err) {
        // Ignore close errors
      }
      this._browser = null;
      this._context = null;
      this._page = null;
      this._loggedIn = false;
    }
  }

  /**
   * Check if the session is currently active.
   * @returns {boolean}
   */
  get isActive() {
    return this._browser !== null && this._page !== null && !this._page.isClosed();
  }

  /**
   * Get login count (for diagnostics).
   * @returns {number}
   */
  get loginCount() {
    return this._loginCount;
  }

  /** @private */
  async _login() {
    const loggerAdapter = this.logger
      ? { log: (...a) => this.logger.log(...a), verbose: (...a) => this.logger.verbose(...a), error: (...a) => this.logger.error(...a) }
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

module.exports = { SportlinkSession };
