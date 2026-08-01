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

const READ_ONLY_OR_UNREGISTERED_PERSON_FIELDS = new Set([
  'birth_year',
  'factuur_email',
  'factuur_referentie'
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

function toBooleanFlag(value) {
  return value === true || value === 1 || value === '1';
}

function sanitizeRelationship(relationship) {
  return {
    related_person_id: Number(relationship?.related_person_id) || 0,
    relationship_type_id: Number(relationship?.relationship_type_id) || 0,
    relationship_label: String(relationship?.relationship_label || '')
  };
}

module.exports = {
  ADDRESS_FIELDS,
  DIRECT_FIELDS,
  READ_ONLY_OR_UNREGISTERED_PERSON_FIELDS,
  applyCanonicalResolution,
  sanitizeRelationship,
  toBooleanFlag
};
