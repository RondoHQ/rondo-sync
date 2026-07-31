'use strict';

const DIRECT_FIELDS = new Set([
  'email_1',
  'email_2',
  'mobile_1',
  'mobile_2',
  'telephone_1',
  'telephone_2',
  'datum_vog',
  'freescout_id',
  'financiele_blokkade'
]);

const ADDRESS_FIELDS = new Set([
  'street_name',
  'house_number',
  'house_number_addition',
  'postal_code',
  'city',
  'country_code'
]);

/**
 * Apply one conflict-resolution result to the canonical fields contract.
 * Unknown identifiers fail closed instead of inventing a dashed storage name.
 *
 * @param {Object} fields Canonical person fields payload.
 * @param {string} identifier Tracked conflict field.
 * @param {*} value Winning value.
 */
function applyCanonicalResolution(fields, identifier, value) {
  if (DIRECT_FIELDS.has(identifier)) {
    fields[identifier] = value;
    return;
  }

  if (ADDRESS_FIELDS.has(identifier)) {
    if (!Array.isArray(fields.addresses)) fields.addresses = [];
    let address = fields.addresses.find((row) => row.address_label === 'Home');
    if (!address) {
      address = { address_label: 'Home' };
      fields.addresses.push(address);
    }
    address[identifier] = value;
    return;
  }

  throw new Error(`Unknown canonical conflict field: ${identifier}`);
}

module.exports = {
  ADDRESS_FIELDS,
  DIRECT_FIELDS,
  applyCanonicalResolution
};
