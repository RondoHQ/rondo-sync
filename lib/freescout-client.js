require('dotenv/config');

const { readEnv } = require('./utils');
const { createLoggerAdapter } = require('./log-adapters');
const { makeRequest } = require('./http-client');

/**
 * Check if FreeScout credentials are configured
 * @returns {{configured: boolean, missing: string[]}}
 */
function checkCredentials() {
  const apiKey = readEnv('FREESCOUT_API_KEY');
  const baseUrl = readEnv('FREESCOUT_BASE_URL');
  const missing = [];

  if (!apiKey) missing.push('FREESCOUT_API_KEY');
  if (!baseUrl) missing.push('FREESCOUT_BASE_URL');

  return {
    configured: missing.length === 0,
    missing
  };
}

/**
 * Make an authenticated request to FreeScout REST API
 * @param {string} endpoint - API endpoint (e.g., '/api/users/me')
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
 * @param {Object|null} body - Request body (will be JSON stringified)
 * @param {Object} options - Optional parameters
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose] - Verbose mode
 * @returns {Promise<{status: number, body: any}>}
 */
async function freescoutRequest(endpoint, method, body = null, options = {}) {
  const creds = checkCredentials();
  if (!creds.configured) {
    throw new Error(`Missing ${creds.missing.join(' and ')}`);
  }

  const apiKey = readEnv('FREESCOUT_API_KEY');
  const baseUrl = readEnv('FREESCOUT_BASE_URL');

  return makeRequest({
    baseUrl,
    endpoint,
    method,
    body,
    headers: {
      'X-FreeScout-API-Key': apiKey
    },
    apiName: 'FreeScout API',
    options
  });
}

/**
 * Test connection to FreeScout API
 * @param {Object} options - Optional parameters
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose] - Verbose mode
 * @returns {Promise<{success: boolean, user?: Object, error?: string}>}
 */
async function testConnection(options = {}) {
  const { logger, verbose = false } = options;
  const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

  // First check if credentials are configured
  const creds = checkCredentials();
  if (!creds.configured) {
    return {
      success: false,
      error: `Missing ${creds.missing.join(' and/or ')}`
    };
  }

  try {
    logVerbose('Testing FreeScout connection...');

    // Request current user endpoint to verify credentials
    const response = await freescoutRequest('/api/users/me', 'GET', null, options);

    logVerbose(`Connected as: ${response.body.first_name || ''} ${response.body.last_name || ''}`);

    return {
      success: true,
      user: response.body
    };
  } catch (error) {
    const errorMessage = error.message || 'Connection failed';

    return {
      success: false,
      error: errorMessage,
      details: error.details
    };
  }
}

/**
 * Make a FreeScout request with retry logic for 5xx errors
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {Object|null} body - Request body
 * @param {Object} options - Optional parameters
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<{status: number, body: any}>}
 */
async function freescoutRequestWithRetry(endpoint, method, body = null, options = {}, maxRetries = 3) {
  const { logger, verbose = false } = options;
  const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await freescoutRequest(endpoint, method, body, options);
    } catch (error) {
      lastError = error;
      const status = error.status;
      const isTimeoutError = /timeout/i.test(error.message || '');

      // Retry on API 5xx errors and network timeouts.
      if (!isTimeoutError && (!status || status < 500)) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        const reason = isTimeoutError ? 'timeout' : `server error (${status})`;
        logVerbose(`FreeScout ${reason}, retrying in ${delay / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

module.exports = { freescoutRequest, freescoutRequestWithRetry, testConnection, checkCredentials };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');

  testConnection({ verbose })
    .then((result) => {
      if (result.success) {
        console.log('FreeScout connection OK');
        if (verbose && result.user) {
          console.log(`User: ${result.user.first_name || ''} ${result.user.last_name || ''} (${result.user.email || 'no email'})`);
        }
        process.exitCode = 0;
      } else {
        console.error(`FreeScout connection FAILED: ${result.error}`);
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
