require('dotenv/config');

const otplib = require('otplib');
const { readEnv } = require('./utils');

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
  await page.click('#kc-login', { timeout: LOGIN_ELEMENT_TIMEOUT_MS });

  await page.waitForLoadState('networkidle');

  logger?.verbose('Verifying login success...');

  const onAuthDomain = () => page.url().includes('/auth/realms/');
  if (onAuthDomain()) {
    throw new Error('Login failed: still on authentication page');
  }

  for (const selector of DASHBOARD_SELECTORS) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      logger?.verbose(`Login successful (matched selector: ${selector})`);
      return;
    } catch (error) {
      // Try next selector
    }
  }

  const loginFormStillVisible = await page.$(LOGIN_PAGE_SELECTOR);
  if (loginFormStillVisible || onAuthDomain()) {
    throw new Error('Login failed: Could not find dashboard element');
  }

  // Fallback: no auth page and no login form visible usually means successful redirect.
  logger?.verbose('Login likely successful (no auth page and no login form visible)');
}

module.exports = { loginToSportlink };
