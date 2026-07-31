/**
 * Shared HTTP client for making authenticated API requests.
 *
 * Consolidates common HTTP request logic used by rondo-club-client and freescout-client.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { createLoggerAdapter } = require('./log-adapters');

const DEFAULT_TIMEOUT = 30000; // 30 seconds (socket idle)

// Hard total-time deadline per request. Catches the case where a
// Cloudflare-fronted endpoint keeps the socket "active" (slow trickle, zero
// window, server stuck on a slow PUT) so the node-level idle `timeout` never
// fires and the Promise hangs forever. See 2026-05-28 sync-people incident.
function parseDeadlineEnv() {
  const raw = process.env.RONDO_SYNC_HTTP_DEADLINE_MS;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const DEFAULT_DEADLINE_MS = parseDeadlineEnv() || 45000;

/**
 * Make an authenticated HTTP request.
 *
 * @param {Object} config - Request configuration
 * @param {string} config.baseUrl - Base URL for the API
 * @param {string} config.endpoint - API endpoint path
 * @param {string} config.method - HTTP method (GET, POST, PUT, DELETE)
 * @param {Object} [config.body] - Request body (will be JSON stringified)
 * @param {Object} [config.headers] - Custom headers to include
 * @param {string} [config.apiName='API'] - API name for error messages
 * @param {number} [config.timeout=30000] - Socket-idle timeout in milliseconds
 * @param {number} [config.deadline=45000] - Hard total-time deadline in milliseconds.
 *   Overrides env RONDO_SYNC_HTTP_DEADLINE_MS. Rejects with code ERR_REQUEST_DEADLINE
 *   regardless of socket state — protects against keep-alive sockets that never go idle.
 * @param {Object} [config.options] - Additional options (logger, verbose)
 * @returns {Promise<{status: number, body: any}>}
 */
function makeRequest(config) {
  return new Promise((resolve, reject) => {
    const {
      baseUrl,
      endpoint,
      method,
      body = null,
      headers = {},
      apiName = 'API',
      timeout = DEFAULT_TIMEOUT,
      deadline = DEFAULT_DEADLINE_MS,
      options = {}
    } = config;

    const { logger, verbose = false } = options;
    const { verbose: logVerbose } = createLoggerAdapter({ logger, verbose });

    // Parse base URL
    let parsedUrl;
    try {
      parsedUrl = new URL(baseUrl);
    } catch (err) {
      reject(new Error(`Invalid base URL: ${baseUrl}`));
      return;
    }

    // Determine protocol module
    const isHttps = parsedUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // Build full path
    const fullPath = endpoint.startsWith('/')
      ? endpoint
      : `/${endpoint}`;

    logVerbose(`${method} ${fullPath}`);

    // Prepare request body
    const requestBody = body ? JSON.stringify(body) : null;

    const requestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: fullPath,
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      timeout
    };

    if (requestBody) {
      requestOptions.headers['Content-Length'] = Buffer.byteLength(requestBody);
    }

    // Single-settle guard so the deadline path, socket-idle path, and natural
    // response path can all race without double-settling the Promise.
    let settled = false;
    let deadlineTimer = null;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(value);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      reject(err);
    };

    const req = httpModule.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        logVerbose(`Response status: ${res.statusCode}`);

        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          // Non-JSON response
          parsed = data;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          settleResolve({ status: res.statusCode, body: parsed, headers: res.headers });
        } else {
          const error = new Error(`${apiName} error (${res.statusCode})`);
          error.status = res.statusCode;
          error.details = parsed;
          settleReject(error);
        }
      });
    });

    req.on('error', (err) => {
      if (err.code === 'ETIMEDOUT') {
        const timeoutError = new Error(`Request timeout: ${apiName} did not respond within ${timeout / 1000} seconds`);
        timeoutError.code = 'ETIMEDOUT';
        settleReject(timeoutError);
      } else {
        settleReject(err);
      }
    });

    req.on('timeout', () => {
      req.destroy();
      const timeoutError = new Error(`Request timeout: ${apiName} did not respond within ${timeout / 1000} seconds`);
      timeoutError.code = 'ETIMEDOUT';
      settleReject(timeoutError);
    });

    // Hard deadline — fires regardless of socket state.
    deadlineTimer = setTimeout(() => {
      const err = new Error(`Request deadline exceeded: ${apiName} did not complete within ${deadline / 1000} seconds`);
      err.code = 'ERR_REQUEST_DEADLINE';
      try { req.destroy(err); } catch (_) { /* req may already be destroyed */ }
      settleReject(err);
    }, deadline);
    // Don't keep the event loop alive solely for this timer — if everything
    // else settles, we want the process to exit.
    if (deadlineTimer.unref) deadlineTimer.unref();

    if (requestBody) {
      req.write(requestBody);
    }

    req.end();
  });
}

/**
 * Create Basic Auth header value.
 * @param {string} username
 * @param {string} password
 * @returns {string} Authorization header value
 */
function createBasicAuthHeader(username, password) {
  const authString = `${username}:${password}`;
  return `Basic ${Buffer.from(authString).toString('base64')}`;
}

module.exports = {
  makeRequest,
  createBasicAuthHeader,
  DEFAULT_TIMEOUT,
  DEFAULT_DEADLINE_MS
};
