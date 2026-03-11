/**
 * Sync origin and timestamp utilities for bidirectional sync.
 * Provides constants and functions for tracking field modifications
 * and detecting conflicts between Sportlink and Rondo Club.
 */

/**
 * Origin constants indicating the source of the last modification.
 * Used to distinguish user edits from sync-initiated changes.
 */
const SYNC_ORIGIN = {
  /** Manual edit in Rondo Club WordPress */
  USER_EDIT: 'user_edit',
  /** Forward sync from Sportlink to Rondo Club */
  SYNC_FORWARD: 'sync_sportlink_to_rondo_club',
  /** Reverse sync from Rondo Club to Sportlink */
  SYNC_REVERSE: 'sync_rondo_club_to_sportlink'
};

/**
 * Fields that have bidirectional timestamp tracking.
 * Each field has two timestamp columns: {field}_rondo_club_modified and {field}_sportlink_modified
 */
const TRACKED_FIELDS = [
  'email_1',            // was 'email'
  'email_2',            // was 'email2'
  'mobile_1',           // was 'mobile'
  'mobile_2',           // NEW — was not tracked
  'telephone_1',        // was 'phone'
  'telephone_2',        // NEW — was not tracked
  'datum_vog',
  'freescout_id',
  'financiele_blokkade',
  // Home address fields (from addresses repeater, first row with label 'Home')
  'street_name',
  'house_number',
  'house_number_addition',
  'postal_code',
  'city',
  'country_code'
];

/**
 * Creates a timestamp in ISO 8601 UTC format.
 * Consistent with existing codebase pattern (new Date().toISOString()).
 * @returns {string} Current time in ISO 8601 UTC format (e.g., "2026-01-29T14:30:00.000Z")
 */
function createTimestamp() {
  return new Date().toISOString();
}

/**
 * Compares two ISO 8601 timestamps with clock drift tolerance.
 * Used for conflict detection to determine which system has the newer value.
 *
 * @param {string|null} ts1 - First timestamp (ISO 8601 format) or null
 * @param {string|null} ts2 - Second timestamp (ISO 8601 format) or null
 * @param {number} [toleranceMs=5000] - Tolerance in milliseconds for clock drift
 * @returns {number} 1 if ts1 is newer (by more than tolerance),
 *                   -1 if ts2 is newer (by more than tolerance),
 *                   0 if within tolerance (too close to call)
 *
 * @example
 * // Returns 1 (ts1 is newer)
 * compareTimestamps('2026-01-29T14:30:00.000Z', '2026-01-29T14:00:00.000Z')
 *
 * @example
 * // Returns 0 (within tolerance)
 * compareTimestamps('2026-01-29T14:30:00.000Z', '2026-01-29T14:30:03.000Z')
 *
 * @example
 * // Returns -1 (null is treated as infinitely old)
 * compareTimestamps(null, '2026-01-29T14:30:00.000Z')
 */
function compareTimestamps(ts1, ts2, toleranceMs = 5000) {
  // NULL is treated as infinitely old (epoch)
  const time1 = ts1 ? new Date(ts1).getTime() : 0;
  const time2 = ts2 ? new Date(ts2).getTime() : 0;

  const diff = time1 - time2;

  if (diff > toleranceMs) {
    return 1;  // ts1 is newer by more than tolerance
  } else if (diff < -toleranceMs) {
    return -1; // ts2 is newer by more than tolerance
  } else {
    return 0;  // Within tolerance, too close to call
  }
}

/**
 * Returns the column names for a field's timestamps.
 * Each tracked field has two timestamp columns in rondo_club_members.
 *
 * @param {string} field - Field name from TRACKED_FIELDS
 * @returns {{rondo_club: string, sportlink: string}} Object with column names
 *
 * @example
 * // Returns { rondo_club: 'email_rondo_club_modified', sportlink: 'email_sportlink_modified' }
 * getTimestampColumnNames('email')
 */
function getTimestampColumnNames(field) {
  return {
    rondo_club: `${field}_rondo_club_modified`,
    sportlink: `${field}_sportlink_modified`
  };
}

module.exports = {
  SYNC_ORIGIN,
  TRACKED_FIELDS,
  createTimestamp,
  compareTimestamps,
  getTimestampColumnNames
};
