require('dotenv/config');

const otplib = require('otplib');
const { readEnv } = require('./utils');

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

  logger?.verbose('Filling login credentials...');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');

  logger?.verbose('Waiting for OTP prompt...');
  await page.waitForSelector('#otp', { timeout: 20000 });

  if (!otpSecret) {
    throw new Error('Missing SPORTLINK_OTP_SECRET');
  }

  const otpCode = await otplib.generate({ secret: otpSecret });
  if (!otpCode) {
    throw new Error('Failed to generate OTP code');
  }

  logger?.verbose('Submitting OTP...');
  await page.fill('#otp', otpCode);
  await page.click('#kc-login');

  await page.waitForLoadState('networkidle');

  logger?.verbose('Verifying login success...');
  try {
    await page.waitForSelector('#panelHeaderTasks', { timeout: 40000 });
    logger?.verbose('Login successful');
  } catch (error) {
    throw new Error('Login failed: Could not find dashboard element');
  }
}

module.exports = { loginToSportlink };
