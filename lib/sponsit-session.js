/**
 * Authenticated Sponsit browser session with cross-process storage-state reuse.
 *
 * Sponsit exposes its Laravel/Inertia pages as JSON when requested with the
 * standard X-Inertia headers. A real browser login is still required to obtain
 * the session cookies; subsequent reads use Playwright's context request client.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');
const { readEnv } = require('./utils');
const { decodeBase32, generateTotpWithKey, parseOtpAuthUrl } = require('./totp');

const STATE_FILE = path.join(process.cwd(), 'data', 'sponsit-storage-state.json');
const LOCK_FILE = path.join(process.cwd(), 'data', 'sponsit-storage-state.lock');

// Sponsit's observed session lifetime is four hours. Refresh before that hard
// boundary so cron jobs do not start with a nearly-expired cached session.
const MAX_SESSION_AGE_MS = 3 * 60 * 60 * 1000;
const RECENT_REFRESH_WINDOW_MS = 60 * 1000;

class SponsitRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'SponsitRequestError';
    this.status = options.status || null;
    this.url = options.url || null;
    this.retryable = options.retryable === true;
  }
}

class SponsitSession {
  constructor(options = {}) {
    const configuredUrl = options.url || readEnv('SPONSIT_URL');
    this.origin = configuredUrl ? validateSponsitUrl(configuredUrl) : '';
    this.username = options.username || readEnv('SPONSIT_USERNAME');
    this.password = options.password || readEnv('SPONSIT_PASSWORD');
    this.otpSecret = options.otpSecret || readEnv('SPONSIT_OTP_SECRET');
    this.logger = options.logger || null;
    this.useStorageCache = options.useStorageCache !== false;
    this.stateFile = options.stateFile || STATE_FILE;
    this.lockFile = options.lockFile || LOCK_FILE;
    this.browserChannel = options.browserChannel || readEnv('SPONSIT_BROWSER_CHANNEL');
    this._browser = null;
    this._context = null;
    this._page = null;
    this._inertiaVersion = null;
    this._loginCount = 0;
    this._reusedFromCache = false;
  }

  async getPage() {
    if (this._page && !this._page.isClosed()) return this._page;
    this._validateConfiguration();

    this._browser = await this._launchBrowser();

    if (this.useStorageCache) {
      const cached = await loadCachedState(this.stateFile);
      if (cached && await this._tryReuse(cached)) {
        this._reusedFromCache = true;
        return this._page;
      }

      await acquireLock(this.lockFile, this.logger);
      try {
        const refreshed = await loadCachedState(this.stateFile, {
          maxAgeMs: RECENT_REFRESH_WINDOW_MS
        });
        if (refreshed && await this._tryReuse(refreshed)) {
          this._reusedFromCache = true;
          return this._page;
        }

        await this._openContext();
        await this._login();
        await saveState(this._context, this.stateFile, this.logger);
      } finally {
        await releaseLock(this.lockFile);
      }
    } else {
      await this._openContext();
      await this._login();
    }

    return this._page;
  }

  /**
   * Fetch an authenticated Inertia page as JSON.
   *
   * @param {string} relativeUrl Path such as `/contacts?page=1`
   * @param {Object} [options]
   * @param {boolean} [options.retryAuth=true] Retry once after a stale session
   * @returns {Promise<Object>}
   */
  async requestInertia(relativeUrl, options = {}) {
    const retryAuth = options.retryAuth !== false;
    await this.getPage();

    const url = new URL(relativeUrl, this.origin).toString();
    const headers = {
      Accept: 'text/html, application/xhtml+xml',
      'X-Inertia': 'true',
      'X-Requested-With': 'XMLHttpRequest'
    };
    if (this._inertiaVersion) headers['X-Inertia-Version'] = this._inertiaVersion;

    let response;
    try {
      response = await this._context.request.get(url, { headers, timeout: 30000 });
    } catch (error) {
      throw new SponsitRequestError(`Sponsit request failed: ${error.message}`, {
        url,
        retryable: true
      });
    }

    const status = response.status();
    const contentType = response.headers()['content-type'] || '';
    const finalUrl = response.url();
    const authenticationLost = [401, 419].includes(status)
      || finalUrl.includes('/login')
      || !contentType.includes('json');

    if (authenticationLost && retryAuth) {
      this.logger?.verbose('Sponsit session expired while reading data; logging in again');
      await this.relogin();
      return this.requestInertia(relativeUrl, { retryAuth: false });
    }

    if (!response.ok() || !contentType.includes('json')) {
      throw new SponsitRequestError(
        `Sponsit returned HTTP ${status} for ${new URL(finalUrl).pathname}`,
        {
          status,
          url: finalUrl,
          retryable: status === 429 || status >= 500
        }
      );
    }

    try {
      return await response.json();
    } catch (error) {
      throw new SponsitRequestError(`Invalid Sponsit JSON response: ${error.message}`, {
        status,
        url: finalUrl,
        retryable: false
      });
    }
  }

  /** Download one authenticated Sponsit file without exposing session cookies. */
  async requestFile(relativeUrl, options = {}) {
    const retryAuth = options.retryAuth !== false;
    const maxBytes = Number(options.maxBytes || 5 * 1024 * 1024);
    await this.getPage();

    const target = new URL(relativeUrl, this.origin);
    if (target.origin !== this.origin) {
      throw new SponsitRequestError('Sponsit file URL must stay on the configured origin', {
        url: target.toString(),
        retryable: false
      });
    }

    let response;
    try {
      response = await this._context.request.get(target.toString(), { timeout: 30000 });
    } catch (error) {
      throw new SponsitRequestError(`Sponsit file request failed: ${error.message}`, {
        url: target.toString(),
        retryable: true
      });
    }

    const status = response.status();
    const headers = response.headers();
    const contentType = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const finalUrl = response.url();
    const authenticationLost = [401, 419].includes(status)
      || finalUrl.includes('/login')
      || contentType === 'text/html';

    if (authenticationLost && retryAuth) {
      this.logger?.verbose('Sponsit session expired while downloading a file; logging in again');
      await this.relogin();
      return this.requestFile(relativeUrl, { ...options, retryAuth: false });
    }
    if (!response.ok()) {
      throw new SponsitRequestError(`Sponsit returned HTTP ${status} for ${new URL(finalUrl).pathname}`, {
        status,
        url: finalUrl,
        retryable: status === 429 || status >= 500
      });
    }
    if (!contentType.startsWith('image/')) {
      throw new SponsitRequestError(`Sponsit logo has unsupported content type ${contentType || 'unknown'}`, {
        status,
        url: finalUrl,
        retryable: false
      });
    }

    const declaredSize = Number(headers['content-length'] || 0);
    if (declaredSize > maxBytes) {
      throw new SponsitRequestError('Sponsit logo exceeds the 5MB import limit', {
        status,
        url: finalUrl,
        retryable: false
      });
    }
    const buffer = await response.body();
    if (buffer.length > maxBytes) {
      throw new SponsitRequestError('Sponsit logo exceeds the 5MB import limit', {
        status,
        url: finalUrl,
        retryable: false
      });
    }

    return { buffer, contentType };
  }

  async relogin() {
    this._validateConfiguration();
    if (!this._browser) this._browser = await this._launchBrowser();
    if (!this._context) await this._openContext();

    await acquireLock(this.lockFile, this.logger);
    try {
      await this._context.clearCookies();
      await fsp.unlink(this.stateFile).catch(() => {});
      await this._login();
      if (this.useStorageCache) {
        await saveState(this._context, this.stateFile, this.logger);
      }
    } finally {
      await releaseLock(this.lockFile);
    }
  }

  async close() {
    if (!this._browser) return;
    await this._browser.close().catch(() => {});
    this._browser = null;
    this._context = null;
    this._page = null;
    this._inertiaVersion = null;
  }

  get loginCount() {
    return this._loginCount;
  }

  get reusedFromCache() {
    return this._reusedFromCache;
  }

  static async withSession(options, fn) {
    const session = new SponsitSession(options);
    try {
      await session.getPage();
      return await fn(session);
    } finally {
      await session.close();
    }
  }

  _validateConfiguration() {
    if (!this.origin || !this.username || !this.password) {
      throw new Error('Missing SPONSIT_URL, SPONSIT_USERNAME or SPONSIT_PASSWORD');
    }
  }

  async _launchBrowser() {
    const launchOptions = { headless: true };
    if (this.browserChannel) launchOptions.channel = this.browserChannel;

    try {
      return await chromium.launch(launchOptions);
    } catch (error) {
      // Local development often has Chrome installed but not Playwright's
      // downloaded Chromium. Production continues using bundled Chromium.
      if (!this.browserChannel && /Executable doesn't exist/i.test(error.message)) {
        this.logger?.verbose('Bundled Chromium unavailable; falling back to installed Chrome');
        return chromium.launch({ headless: true, channel: 'chrome' });
      }
      throw error;
    }
  }

  async _openContext(storageState = undefined) {
    if (this._context) await this._context.close().catch(() => {});
    this._context = await this._browser.newContext({
      acceptDownloads: false,
      ...(storageState ? { storageState } : {})
    });
    this._page = await this._context.newPage();
  }

  async _tryReuse(storageState) {
    try {
      await this._openContext(storageState);
      await this._page.goto(this.origin, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      if (this._page.url().includes('/login')) {
        await this._context.close().catch(() => {});
        this._context = null;
        this._page = null;
        return false;
      }
      await this._captureInertiaVersion();
      this.logger?.verbose('Reused cached Sponsit session');
      return true;
    } catch (error) {
      this.logger?.verbose(`Cached Sponsit session could not be reused: ${error.message}`);
      if (this._context) await this._context.close().catch(() => {});
      this._context = null;
      this._page = null;
      return false;
    }
  }

  async _login() {
    await this._page.goto(this.origin, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!this._page.url().includes('/login')) {
      await this._captureInertiaVersion();
      return;
    }

    const email = this._page.locator('input[type="email"]');
    const password = this._page.locator('input[type="password"]');
    await email.waitFor({ state: 'visible', timeout: 15000 });
    await email.fill(this.username);
    await password.fill(this.password);
    await this._page.getByRole('button', { name: 'Inloggen', exact: true }).click();
    await this._page.waitForURL((url) => !url.pathname.includes('/login'), {
      timeout: 30000
    });

    if (this._page.url().includes('/two-factor-challenge')) {
      await this._submitTotpChallenge();
    }

    await this._page.goto(new URL('/contacts', this.origin).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    const dataPage = JSON.parse(await this._page.locator('[data-page]').getAttribute('data-page'));
    if (this._page.url().includes('/login') || dataPage.component !== 'Contacts/Index') {
      throw new Error('Sponsit login failed: protected contacts page is unavailable');
    }
    this._inertiaVersion = dataPage.version || null;
    this._loginCount++;
    this.logger?.verbose('Sponsit login successful');
  }

  async _submitTotpChallenge() {
    if (!this.otpSecret) {
      throw new Error('Missing SPONSIT_OTP_SECRET for Sponsit two-factor authentication');
    }

    const otpCode = generateSponsitTotp(this.otpSecret);
    if (!/^\d{6}$/.test(otpCode)) {
      throw new Error('Failed to generate a valid Sponsit OTP code');
    }

    const codeInput = this._page.locator([
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
      'input[inputmode="numeric"]',
      'input[type="text"]'
    ].join(', ')).first();
    await codeInput.waitFor({ state: 'visible', timeout: 15000 });
    await codeInput.fill(otpCode);
    await this._page.getByRole('button', { name: 'Login', exact: true }).click();
    await this._page.waitForURL((url) => !url.pathname.includes('/two-factor-challenge'), {
      timeout: 30000
    });

    if (this._page.url().includes('/login')) {
      throw new Error('Sponsit two-factor authentication was rejected');
    }
    this.logger?.verbose('Sponsit two-factor authentication successful');
  }

  async _captureInertiaVersion() {
    const dataPage = await this._page.locator('[data-page]').getAttribute('data-page');
    if (!dataPage) throw new Error('Sponsit did not return an authenticated Inertia page');
    const page = JSON.parse(dataPage);
    this._inertiaVersion = page.version || null;
  }
}

function validateSponsitUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error('SPONSIT_URL must use HTTPS to protect the login credentials');
  }
  return url.origin;
}

function extractTotpSecret(value) {
  const raw = String(value || '').trim();
  if (raw.startsWith('otpauth://')) {
    const secret = new URL(raw).searchParams.get('secret');
    if (!secret) throw new Error('SPONSIT_OTP_SECRET otpauth URL has no secret parameter');
    return secret.replace(/[\s-]+/g, '').toUpperCase();
  }
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

function generateSponsitTotp(value) {
  const parsed = parseOtpAuthUrl(String(value || '').trim());
  const secret = extractTotpSecret(value);
  const key = decodeBase32(secret);
  if (key.length === 0) throw new Error('SPONSIT_OTP_SECRET is not valid Base32');
  return generateTotpWithKey(
    key,
    parsed?.digits || 6,
    parsed?.period || 30,
    parsed?.algorithm || 'SHA1'
  );
}

async function invalidateCachedSponsitSession(stateFile = STATE_FILE) {
  await fsp.unlink(stateFile).catch(() => {});
}

async function loadCachedState(stateFile, { maxAgeMs = MAX_SESSION_AGE_MS } = {}) {
  try {
    const stat = await fsp.stat(stateFile);
    if (Date.now() - stat.mtimeMs > maxAgeMs) return null;
    return JSON.parse(await fsp.readFile(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

async function saveState(context, stateFile, logger) {
  try {
    await fsp.mkdir(path.dirname(stateFile), { recursive: true });
    const state = await context.storageState();
    await fsp.writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    await fsp.chmod(stateFile, 0o600);
    logger?.verbose('Persisted Sponsit session securely to disk');
  } catch (error) {
    logger?.error?.(`Could not persist Sponsit session: ${error.message}`);
  }
}

async function acquireLock(lockFile, logger) {
  const start = Date.now();
  const timeoutMs = 60 * 1000;
  const staleMs = 120 * 1000;
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });

  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = await fsp.stat(lockFile);
        if (Date.now() - stat.mtimeMs > staleMs) {
          logger?.verbose('Removing stale Sponsit session lock');
          await fsp.unlink(lockFile).catch(() => {});
          continue;
        }
      } catch {
        // Lock disappeared between stat/open; retry immediately.
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Timed out waiting for Sponsit session lock');
}

async function releaseLock(lockFile) {
  await fsp.unlink(lockFile).catch(() => {});
}

module.exports = {
  SponsitSession,
  SponsitRequestError,
  invalidateCachedSponsitSession,
  extractTotpSecret,
  generateSponsitTotp,
  validateSponsitUrl,
  STATE_FILE
};
