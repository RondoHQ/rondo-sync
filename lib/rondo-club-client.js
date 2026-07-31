require('dotenv/config');

const { readEnv } = require('./utils');
const { createLoggerAdapter } = require('./log-adapters');
const { makeRequest, createBasicAuthHeader } = require('./http-client');

/**
 * Validate Rondo Club credentials exist
 * @throws {Error} If credentials are missing or invalid
 */
function validateCredentials() {
  const url = readEnv('RONDO_URL');
  const username = readEnv('RONDO_USERNAME');
  const password = readEnv('RONDO_APP_PASSWORD');

  if (!url || !username || !password) {
    throw new Error('RONDO_URL, RONDO_USERNAME, and RONDO_APP_PASSWORD required in .env');
  }

  if (!url.startsWith('https://')) {
    throw new Error('RONDO_URL must start with https://');
  }
}

/**
 * Make an authenticated request to Rondo Club WordPress REST API
 * @param {string} endpoint - API endpoint (e.g., 'wp/v2/users/me' or full path)
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {Object|null} body - Request body (will be JSON stringified)
 * @param {Object} options - Optional parameters
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose] - Verbose mode
 * @returns {Promise<{status: number, body: any, headers: Object}>}
 */
async function rondoClubRequest(endpoint, method, body = null, options = {}) {
  validateCredentials();

  const baseUrl = readEnv('RONDO_URL');
  const username = readEnv('RONDO_USERNAME');
  const password = readEnv('RONDO_APP_PASSWORD');

  // Build endpoint path - add /wp-json/ prefix if not starting with /
  const fullEndpoint = endpoint.startsWith('/')
    ? endpoint
    : `/wp-json/${endpoint}`;

  return makeRequest({
    baseUrl,
    endpoint: fullEndpoint,
    method,
    body,
    headers: {
      'Authorization': createBasicAuthHeader(username, password)
    },
    apiName: 'Rondo Club API',
    options
  });
}

/**
 * Make an authenticated request to Rondo Club with retry logic for transient errors.
 * Uses exponential backoff: 1s, 2s, 4s between retries.
 * Only retries on 5xx server errors.
 *
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {Object|null} body - Request body
 * @param {Object} options - Optional parameters
 * @param {number} [maxRetries=3] - Maximum retry attempts
 * @returns {Promise<{status: number, body: any, headers: Object}>}
 */
async function rondoClubRequestWithRetry(endpoint, method, body = null, options = {}, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await rondoClubRequest(endpoint, method, body, options);
    } catch (error) {
      lastError = error;

      // Only retry on 5xx errors (server errors)
      const status = error.message?.match(/\((\d+)\)/)?.[1];
      if (!status || parseInt(status, 10) < 500) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Parse WordPress error response
 * @param {Object|string} errorBody - Error response from WordPress
 * @returns {Object} Normalized error object
 */
function parseWordPressError(errorBody) {
  if (typeof errorBody === 'string') {
    return {
      code: 'unknown',
      message: errorBody,
      status: null
    };
  }

  if (errorBody && typeof errorBody === 'object') {
    return {
      code: errorBody.code || 'unknown',
      message: errorBody.message || JSON.stringify(errorBody),
      status: errorBody.data?.status || errorBody.status || null
    };
  }

  return {
    code: 'unknown',
    message: 'Unknown error',
    status: null
  };
}

/**
 * Test connection to Rondo Club WordPress REST API
 * @param {Object} options - Optional parameters
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose] - Verbose mode
 * @returns {Promise<{success: boolean, name?: string, url?: string, error?: string, details?: Object}>}
 */
async function testConnection(options = {}) {
  const { logger, verbose = false } = options;
  const { verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });

  try {
    logVerbose('Testing Rondo Club connection...');

    // Request WordPress REST API root endpoint
    const response = await rondoClubRequest('', 'GET', null, options);

    const siteName = response.body.name || 'Unknown Site';
    const siteUrl = response.body.url || readEnv('RONDO_URL');

    logVerbose(`Connected to: ${siteName}`);

    return {
      success: true,
      name: siteName,
      url: siteUrl
    };
  } catch (error) {
    const wpError = parseWordPressError(error.details);
    const errorMessage = error.message || 'Connection failed';

    logError(`Connection failed: ${errorMessage}`);
    if (error.details) {
      logVerbose(`Error details: ${JSON.stringify(wpError)}`);
    }

    return {
      success: false,
      error: errorMessage,
      details: wpError
    };
  }
}

module.exports = { rondoClubRequest, rondoClubRequestWithRetry, testConnection };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');

  testConnection({ verbose })
    .then((result) => {
      if (result.success) {
        console.log(`Rondo Club connection OK: ${result.name}`);
        if (verbose) {
          console.log(`URL: ${result.url}`);
        }
        process.exitCode = 0;
      } else {
        console.error(`Rondo Club connection FAILED: ${result.error}`);
        if (verbose && result.details) {
          console.error('Details:', JSON.stringify(result.details, null, 2));
        }
        process.exitCode = 1;
      }
    })
    .catch((err) => {
      console.error('Unexpected error:', err.message);
      if (verbose) {
        console.error(err.stack);
      }
      process.exitCode = 1;
    });
}
