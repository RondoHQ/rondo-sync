/**
 * Laposta API client for sportlink-sync
 *
 * Provides authenticated HTTP requests to the Laposta API.
 * Consolidates common request logic used across Laposta-related scripts.
 */

const https = require('https');
const { readEnv } = require('./utils');

const LAPOSTA_BASE_URL = 'https://api.laposta.nl';
const RATE_LIMIT_DELAY = 2500; // 2.5 seconds between requests

/**
 * Get Laposta API key from environment.
 * @returns {string} API key
 * @throws {Error} If API key is not configured
 */
function getApiKey() {
  const apiKey = readEnv('LAPOSTA_API_KEY');
  if (!apiKey) {
    throw new Error('LAPOSTA_API_KEY not found in .env file');
  }
  return apiKey;
}

/**
 * Create Basic Auth header for Laposta API.
 * @param {string} apiKey - Laposta API key
 * @returns {string} Authorization header value
 */
function createAuthHeader(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
}

/**
 * Make an HTTP request to the Laposta API.
 *
 * @param {Object} config - Request configuration
 * @param {string} config.method - HTTP method
 * @param {string} config.path - API path (e.g., '/v2/member')
 * @param {URLSearchParams} [config.params] - Query parameters
 * @param {Object|string} [config.body] - Request body
 * @param {string} [config.contentType='application/json'] - Content type
 * @returns {Promise<{status: number, body: any}>}
 */
function lapostaRequest(config) {
  return new Promise((resolve, reject) => {
    const {
      method,
      path,
      params,
      body = null,
      contentType = 'application/json'
    } = config;

    const apiKey = getApiKey();
    const url = new URL(path, LAPOSTA_BASE_URL);

    if (params) {
      params.forEach((value, key) => {
        url.searchParams.set(key, value);
      });
    }

    const requestBody = body
      ? (contentType === 'application/json' ? JSON.stringify(body) : String(body))
      : null;

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: createAuthHeader(apiKey)
      }
    };

    if (requestBody) {
      options.headers['Content-Type'] = contentType;
      options.headers['Content-Length'] = Buffer.byteLength(requestBody);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }

        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: parsed });
        } else {
          const error = new Error(`Laposta API error (${res.statusCode})`);
          error.status = res.statusCode;
          error.details = parsed;
          reject(error);
        }
      });
    });

    req.on('error', (err) => reject(err));

    if (requestBody) {
      req.write(requestBody);
    }
    req.end();
  });
}

/**
 * Fetch custom fields for a Laposta list.
 * @param {string} listId - Laposta list ID
 * @returns {Promise<Array>} Array of field definitions
 */
async function fetchFields(listId) {
  const params = new URLSearchParams();
  params.set('list_id', listId);

  const response = await lapostaRequest({
    method: 'GET',
    path: '/v2/field',
    params
  });

  if (!response.body || !Array.isArray(response.body.data)) {
    return [];
  }

  return response.body.data.map(item => item.field || item);
}

/**
 * Fetch members from a Laposta list.
 * @param {string} listId - Laposta list ID
 * @param {string} [state] - Optional member state filter (e.g., 'active')
 * @returns {Promise<Array>} Array of member objects
 */
async function fetchMembers(listId, state) {
  const params = new URLSearchParams();
  params.set('list_id', listId);
  if (state) {
    params.set('state', state);
  }

  const response = await lapostaRequest({
    method: 'GET',
    path: '/v2/member',
    params
  });

  return extractMembersFromResponse(response.body);
}

/**
 * Extract members array from Laposta API response.
 * Handles various response formats.
 * @param {any} payload - API response body
 * @returns {Array} Array of member objects
 */
function extractMembersFromResponse(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.members)) return payload.members;
  if (Array.isArray(payload.data)) {
    return payload.data.map(item => item.member || item);
  }
  if (payload.member) return [payload.member];
  return [];
}

/**
 * Append custom fields to URLSearchParams in Laposta format.
 * Handles both scalar values and arrays.
 * @param {URLSearchParams} params - URLSearchParams instance
 * @param {Object} customFields - Custom fields object
 */
function appendCustomFields(params, customFields) {
  if (!customFields || typeof customFields !== 'object') return;

  Object.entries(customFields).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(entry => {
        params.append(`custom_fields[${key}][]`, entry ?? '');
      });
    } else {
      params.append(`custom_fields[${key}]`, value ?? '');
    }
  });
}

/**
 * Upsert a member to a Laposta list.
 * Creates the member if they don't exist, updates if they do.
 *
 * @param {string} listId - Laposta list ID
 * @param {Object} member - Member data
 * @param {string} member.email - Member email
 * @param {Object} [member.custom_fields] - Custom field values
 * @returns {Promise<{status: number, body: any}>}
 */
async function upsertMember(listId, member) {
  const params = new URLSearchParams();
  params.append('list_id', listId);
  params.append('ip', '3.3.3.3');
  params.append('email', member.email);
  params.append('options[upsert]', 'true');
  appendCustomFields(params, member.custom_fields);

  return lapostaRequest({
    method: 'POST',
    path: '/v2/member',
    body: params.toString(),
    contentType: 'application/x-www-form-urlencoded'
  });
}

/**
 * Delete a member from a Laposta list.
 * @param {string} listId - Laposta list ID
 * @param {Object} member - Member object with member_id or email
 * @returns {Promise<{status: number, body: any}>}
 */
async function deleteMember(listId, member) {
  const identifier = member.member_id || member.email || member.EmailAddress;
  if (!identifier) {
    throw new Error('Cannot delete member without member_id or email');
  }

  const params = new URLSearchParams();
  params.set('list_id', listId);

  return lapostaRequest({
    method: 'DELETE',
    path: `/v2/member/${encodeURIComponent(identifier)}`,
    params
  });
}

/**
 * Wait for rate limit delay.
 * Use between sequential API requests to avoid rate limiting.
 * @returns {Promise<void>}
 */
function waitForRateLimit() {
  return new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
}

/**
 * List environment key names for Laposta lists.
 */
const LIST_ENV_KEYS = ['LAPOSTA_LIST', 'LAPOSTA_LIST2', 'LAPOSTA_LIST3', 'LAPOSTA_LIST4'];

/**
 * Get configuration for a Laposta list by index.
 * @param {number} listIndex - List index (1-4)
 * @returns {{envKey: string, listId: string|null}} List configuration
 * @throws {Error} If list index is invalid
 */
function getListConfig(listIndex) {
  const envKey = LIST_ENV_KEYS[listIndex - 1];
  if (!envKey) {
    throw new Error(`Invalid list index ${listIndex}. Use 1-4.`);
  }
  return {
    envKey,
    listId: readEnv(envKey) || null
  };
}

module.exports = {
  lapostaRequest,
  fetchFields,
  fetchMembers,
  extractMembersFromResponse,
  appendCustomFields,
  upsertMember,
  deleteMember,
  waitForRateLimit,
  getListConfig,
  LIST_ENV_KEYS,
  RATE_LIMIT_DELAY
};
