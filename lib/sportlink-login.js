require('dotenv/config');

const otplib = require('otplib');
const { readEnv } = require('./utils');
const { isSportlinkAuthUrl } = require('./sportlink-auth');

const LOGIN_ELEMENT_TIMEOUT_MS = 45000;
const OTP_PROMPT_TIMEOUT_MS = 45000;
const LOGIN_PAGE_SELECTOR = '#username, #password, #kc-login';
const DASHBOARD_SELECTORS = [
  '#panelHeaderTasks',
  '[id*="panelHeader"]',
  'nav[role="navigation"]',
  '[data-testid="dashboard"]',
  'a[href*="/member/"]'
];

/**
 * Login to Sportlink Club with credentials and OTP.
 *
 * @param {Object} page - Playwright page instance
 * @param {Object} [options] - Options
 * @param {Object} [options.logger] - Logger instance with log(), verbose(), error() methods
 * @param {Object} [options.credentials] - Override credentials (defaults to environment variables)
 * @param {string} [options.credentials.username] - Sportlink username
 * @param {string} [options.credentials.password] - Sportlink password
 * @param {string} [options.credentials.otpSecret] - TOTP secret for 2FA
 * @returns {Promise<void>}
 * @throws {Error} If credentials are missing or login fails
 */
async function loginToSportlink(page, options = {}) {
  const { logger, credentials = {} } = options;

  const username = credentials.username || readEnv('SPORTLINK_USERNAME');
  const password = credentials.password || readEnv('SPORTLINK_PASSWORD');
  const otpSecret = credentials.otpSecret || readEnv('SPORTLINK_OTP_SECRET');

  if (!username || !password) {
    throw new Error('Missing SPORTLINK_USERNAME or SPORTLINK_PASSWORD');
  }

  logger?.verbose('Navigating to Sportlink login page...');
  await page.goto('https://club.sportlink.com/', { waitUntil: 'domcontentloaded' });

  logger?.verbose(`Waiting for login form (timeout: ${LOGIN_ELEMENT_TIMEOUT_MS}ms)...`);
  await page.waitForSelector('#username', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });
  await page.waitForSelector('#password', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });
  await page.waitForSelector('#kc-login', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });

  logger?.verbose('Filling login credentials...');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });

  logger?.verbose(`Waiting for OTP prompt (timeout: ${OTP_PROMPT_TIMEOUT_MS}ms)...`);
  await page.waitForSelector('#otp', { timeout: OTP_PROMPT_TIMEOUT_MS });

  if (!otpSecret) {
    throw new Error('Missing SPORTLINK_OTP_SECRET');
  }

  const otpCode = await otplib.generate({ secret: otpSecret });
  if (!otpCode) {
    throw new Error('Failed to generate OTP code');
  }

  logger?.verbose('Submitting OTP...');
  await page.fill('#otp', otpCode);
  await page.waitForSelector('#kc-login', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });
  // Observe the SPA's own authorization request; credentials and OTP can
  // succeed while the club API rejects the resulting session.
  let authorizationRejected = false;
  const onResponse = response => {
    const url = new URL(response.url());
    if (url.hostname === 'club.sportlink.com' &&
        url.pathname === '/navajo/entity/common/clubweb/user/ClubAuthorizations') {
      authorizationRejected = response.status() === 401;
    }
  };
  page.on('response', onResponse);
  try {
    await page.click('#kc-login', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });
    logger?.verbose('Verifying login success...');

    // Returning to Club is intermediate: it can still reject the token and
    // redirect to Keycloak. Require the authenticated UI before saving state.
    await page.waitForURL(url => url.hostname === 'club.sportlink.com' &&
      !isSportlinkAuthUrl(url.href), {
      timeout: LOGIN_ELEMENT_TIMEOUT_MS,
      waitUntil: 'domcontentloaded'
    });
    await page.waitForSelector(DASHBOARD_SELECTORS.join(', '), {
      timeout: LOGIN_ELEMENT_TIMEOUT_MS
    });
    if (isSportlinkAuthUrl(page.url()) || await page.$(LOGIN_PAGE_SELECTOR)) {
      throw new Error('Login failed: returned to authentication page');
    }
    logger?.verbose('Login successful (authenticated dashboard visible)');
  } catch (error) {
    if (authorizationRejected) {
      throw new Error('Login failed: Sportlink ClubAuthorizations rejected the session (HTTP 401) after two-factor authentication', { cause: error });
    }
    throw error;
  } finally {
    page.off('response', onResponse);
  }
}

module.exports = { loginToSportlink };
