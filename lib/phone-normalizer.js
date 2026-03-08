/**
 * Phone number normalization utilities.
 * Ported from PHP PhoneNormalizer (Rondo\Core\PhoneNormalizer).
 *
 * normalizePhone: converts local/international numbers to E.164 format.
 * e164ToLocal: converts E.164 back to Dutch local format for Sportlink.
 */

/**
 * Normalize a phone number to E.164 format.
 *
 * Handles Dutch local numbers (06-xxx, 020-xxx), international (+xx),
 * and 00xx-prefixed international numbers.
 *
 * @param {string} value - Phone number string
 * @returns {string} E.164 formatted number or empty string
 */
function normalizePhone(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  // Strip Unicode invisible characters (zero-width spaces, BOM, directional marks).
  value = value.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '');

  // Trim whitespace.
  value = value.trim();

  if (value === '') {
    return '';
  }

  // Already international format: starts with +.
  if (value.startsWith('+')) {
    // Keep leading +, strip everything except digits from the rest.
    return '+' + value.slice(1).replace(/[^0-9]/g, '');
  }

  // International with 00 prefix (e.g., 0031612345678).
  if (value.startsWith('00')) {
    const digits = value.slice(2).replace(/[^0-9]/g, '');
    return '+' + digits;
  }

  // Dutch local number starting with 0 (e.g., 06-12345678, 020-1234567).
  if (value.startsWith('0')) {
    const digits = value.slice(1).replace(/[^0-9]/g, '');
    return '+31' + digits;
  }

  // Edge case: digits only without leading 0 or +.
  return value.replace(/[^0-9]/g, '');
}

/**
 * Convert E.164 phone number back to Dutch local format for Sportlink.
 *
 * @param {string} value - E.164 phone number (e.g., +31612345678)
 * @returns {string} Local format (e.g., 0612345678) or original if non-Dutch
 */
function e164ToLocal(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }

  value = value.trim();

  if (value === '') {
    return '';
  }

  // Dutch numbers: strip +31, prepend 0.
  if (value.startsWith('+31')) {
    return '0' + value.slice(3);
  }

  // Non-Dutch numbers stay international.
  return value;
}

module.exports = { normalizePhone, e164ToLocal };
