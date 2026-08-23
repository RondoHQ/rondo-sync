require('dotenv/config');

const http = require('http');
const https = require('https');
const FormData = require('form-data');
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

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ERR_REQUEST_DEADLINE'
]);

/**
 * Determine whether a failed Rondo Club request is safe to retry.
 *
 * @param {Error} error - Request failure
 * @returns {boolean} Whether the failure is transient
 */
function isRetryableRondoClubError(error) {
  const status = Number(error?.status || error?.message?.match(/\((\d+)\)/)?.[1]);
  return status >= 500 || TRANSIENT_ERROR_CODES.has(error?.code);
}

/**
 * Retry one transient Rondo Club operation with exponential backoff.
 *
 * @param {Function} operation - Async request function
 * @param {Object} options - Logger and test timing options
 * @param {number} [maxRetries=3] - Maximum retries after the initial attempt
 * @returns {Promise<*>} Operation result
 */
async function retryTransientRondoClubRequest(operation, options = {}, maxRetries = 3) {
  const { logger, verbose = false, retryBaseDelayMs = 1000, sleep = setTimeout } = options;
  const { log } = createLoggerAdapter({ logger, verbose });
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableRondoClubError(error) || attempt === maxRetries) {
        throw error;
      }

      const delay = retryBaseDelayMs * Math.pow(2, attempt);
      log(
        `Rondo Club API request failed transiently (${error.code || error.status || 'server error'}); `
        + `retrying in ${delay / 1000}s (${attempt + 1}/${maxRetries})`
      );
      await new Promise(resolve => sleep(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Make an authenticated request to Rondo Club with retry logic for transient errors.
 * Uses exponential backoff: 1s, 2s, 4s between retries.
 * Retries 5xx responses, timeouts, request deadlines, DNS lookup failures, and connection resets.
 *
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {Object|null} body - Request body
 * @param {Object} options - Optional parameters
 * @param {number} [maxRetries=3] - Maximum retries after the initial attempt
 * @returns {Promise<{status: number, body: any, headers: Object}>}
 */
async function rondoClubRequestWithRetry(endpoint, method, body = null, options = {}, maxRetries = 3) {
  return retryTransientRondoClubRequest(
    () => rondoClubRequest(endpoint, method, body, options),
    options,
    maxRetries
  );
}

/** Upload a buffered file to an authenticated Rondo Club multipart endpoint. */
function rondoClubMultipartRequest(endpoint, file, fields = {}, options = {}) {
  validateCredentials();
  if (!Buffer.isBuffer(file?.buffer) || file.buffer.length === 0) {
    return Promise.reject(new TypeError('A non-empty file buffer is required'));
  }

  const baseUrl = new URL(readEnv('RONDO_URL'));
  const username = readEnv('RONDO_USERNAME');
  const password = readEnv('RONDO_APP_PASSWORD');
  const fullPath = endpoint.startsWith('/') ? endpoint : `/wp-json/${endpoint}`;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) form.append(key, String(value));
  }
  form.append(file.fieldName || 'file', file.buffer, {
    filename: file.filename || 'upload.bin',
    contentType: file.contentType || 'application/octet-stream',
    knownLength: file.buffer.length
  });

  return new Promise((resolve, reject) => {
    const transport = baseUrl.protocol === 'https:' ? https : http;
    const request = transport.request({
      hostname: baseUrl.hostname,
      port: baseUrl.port || (baseUrl.protocol === 'https:' ? 443 : 80),
      path: fullPath,
      method: 'POST',
      headers: {
        Authorization: createBasicAuthHeader(username, password),
        ...form.getHeaders()
      },
      timeout: 30000
    }, (response) => {
      let raw = '';
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch { /* Preserve non-JSON error bodies. */ }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({ status: response.statusCode, body, headers: response.headers });
          return;
        }
        const error = new Error(`Rondo Club API error (${response.statusCode})`);
        error.status = response.statusCode;
        error.details = body;
        reject(error);
      });
    });

    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      const error = new Error('Request timeout: Rondo Club API did not respond within 30 seconds');
      error.code = 'ETIMEDOUT';
      reject(error);
    });
    form.pipe(request);
  });
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

module.exports = {
  rondoClubRequest,
  rondoClubRequestWithRetry,
  retryTransientRondoClubRequest,
  isRetryableRondoClubError,
  rondoClubMultipartRequest,
  testConnection
};

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
