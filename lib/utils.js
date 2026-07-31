/**
 * Shared utility functions for sportlink-sync
 */

const crypto = require('crypto');

/**
 * Deterministic JSON serialization for hash computation.
 * Ensures identical objects always produce the same string representation.
 * @param {any} value - Value to serialize
 * @returns {string} Stable JSON string representation
 */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const entries = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compute SHA-256 hash of serialized data.
 * @param {string} data - Serialized data string
 * @returns {string} SHA-256 hash hex string
 */
function computeHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Format duration in human-readable format.
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "5s", "2m 30s")
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Format timestamp for display (removes T and milliseconds from ISO string).
 * @param {Date} [date] - Date object (defaults to now)
 * @returns {string} Formatted timestamp (e.g., "2026-01-15 10:30:00")
 */
function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * Get current ISO timestamp string.
 * @returns {string} ISO timestamp
 */
function nowISO() {
  return new Date().toISOString();
}

/**
 * Read environment variable with optional fallback.
 * @param {string} name - Environment variable name
 * @param {string} [fallback=''] - Fallback value if not set
 * @returns {string} Environment variable value or fallback
 */
function readEnv(name, fallback = '') {
  return process.env[name] ?? fallback;
}

/**
 * Parse a value as boolean.
 * @param {any} value - Value to parse
 * @param {boolean} [fallback=false] - Fallback if value is undefined
 * @returns {boolean} Parsed boolean value
 */
function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(String(value).toLowerCase());
}

/**
 * Parse common CLI arguments from process.argv.
 * Extracts --verbose and --force flags.
 *
 * @param {string[]} [argv=process.argv] - Command line arguments
 * @returns {{verbose: boolean, force: boolean}}
 */
function parseCliArgs(argv = process.argv) {
  return {
    verbose: argv.includes('--verbose'),
    force: argv.includes('--force')
  };
}

/**
 * Normalize date values to YYYY-MM-DD format.
 * Handles YYYYMMDD, YYYY-MM-DD, and ISO 8601 (with T separator) formats.
 * @param {string|null|undefined} dateValue - Date string to normalize
 * @returns {string|null} Normalized YYYY-MM-DD date or null for invalid/empty input
 */
function normalizeDateToYYYYMMDD(dateValue) {
  // Return null for falsy or non-string input
  if (!dateValue || typeof dateValue !== 'string') {
    return null;
  }

  // Trim and check for empty string
  const trimmed = dateValue.trim();
  if (!trimmed) {
    return null;
  }

  // Handle YYYYMMDD format (8 digits)
  if (/^\d{8}$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const month = trimmed.slice(4, 6);
    const day = trimmed.slice(6, 8);
    return `${year}-${month}-${day}`;
  }

  // Handle ISO 8601 with T separator (e.g., 2026-12-31T00:00:00Z)
  if (trimmed.includes('T')) {
    return trimmed.split('T')[0];
  }

  // Handle already-correct YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Unrecognized format
  return null;
}

/**
 * Normalize supported source date formats to the canonical REST date-only wire format.
 */
function normalizeDateOnly(dateValue) {
  return normalizeDateToYYYYMMDD(dateValue);
}

module.exports = {
  stableStringify,
  computeHash,
  formatDuration,
  formatTimestamp,
  nowISO,
  readEnv,
  parseBool,
  parseCliArgs,
  normalizeDateToYYYYMMDD,
  normalizeDateOnly
};
