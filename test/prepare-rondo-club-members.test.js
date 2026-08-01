'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { preparePerson } = require('../steps/prepare-rondo-club-members');

test('member payload uses only writable canonical fields and null date clears', () => {
  const prepared = preparePerson(
    {
      PublicPersonId: 'KNVB-1',
      FirstName: 'Ada',
      LastName: 'Lovelace',
      DateOfBirth: '1990-01-02',
      RelationEnd: ''
    },
    null,
    {
      invoice_email: 'invoice@example.test',
      invoice_external_code: 'REF-1',
      invoice_address_is_default: 1
    }
  );

  assert.equal(prepared.data.fields.birthdate, '1990-01-02');
  assert.equal(prepared.data.fields.lid_tot, null);
  assert.equal(prepared.data.fields.birth_year, undefined);
  assert.equal(prepared.data.fields.factuur_email, undefined);
  assert.equal(prepared.data.fields.factuur_referentie, undefined);
});

test('retired computed fields are ignored in configurable field mappings', () => {
  const prepared = preparePerson(
    { PublicPersonId: 'KNVB-2', FirstName: 'Grace', LastName: 'Hopper' },
    { remark1: '1906' },
    null,
    [{ source_field: 'Remarks1', target_field: 'birth_year', target_scope: 'fields', value_type: 'number' }]
  );

  assert.equal(prepared.data.fields.birth_year, undefined);
});
