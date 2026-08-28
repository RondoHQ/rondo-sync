'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { preparePerson, deriveYouthAgeClass } = require('../steps/prepare-rondo-club-members');

test('member payload uses only writable canonical fields and null date clears', () => {
  const prepared = preparePerson(
    {
      PublicPersonId: 'KNVB-1',
      FirstName: 'Ada',
      LastName: 'Lovelace',
      DateOfBirth: '1990-01-02',
      DateOfPassing: '2026-08-20',
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
  assert.equal(prepared.data.fields.datum_overlijden, '2026-08-20');
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

test('former Sportlink member types are marked as former immediately', () => {
  for (const memberType of ['Oud bondslid', 'Oud verenigingslid']) {
    const prepared = preparePerson({
      PublicPersonId: `KNVB-${memberType}`,
      FirstName: 'Ada',
      LastName: 'Lovelace',
      TypeOfMemberDescription: memberType
    });

    assert.equal(prepared.data.fields.former_member, true);
  }
});

test('active Sportlink member types remain active', () => {
  const prepared = preparePerson({
    PublicPersonId: 'KNVB-ACTIVE',
    FirstName: 'Grace',
    LastName: 'Hopper',
    TypeOfMemberDescription: 'Bondslid'
  });

  assert.equal(prepared.data.fields.former_member, false);
});

test('youth age class follows the KNVB season boundary instead of the birthday', () => {
  assert.equal(
    deriveYouthAgeClass('2019-08-25', new Date('2026-06-30T12:00:00Z')),
    'Onder 7'
  );
  assert.equal(
    deriveYouthAgeClass('2019-08-25', new Date('2026-07-01T12:00:00Z')),
    'Onder 8'
  );
  assert.equal(
    deriveYouthAgeClass('2019-08-25', new Date('2026-08-24T12:00:00Z')),
    'Onder 8'
  );
});

test('missing Sportlink youth age class is derived and logged', () => {
  const messages = [];
  const prepared = preparePerson(
    {
      PublicPersonId: 'KNVB-YOUTH-MISSING',
      FirstName: 'Noud',
      LastName: 'Test',
      DateOfBirth: '2019-08-25'
    },
    null,
    null,
    [],
    {
      referenceDate: new Date('2026-08-28T12:00:00Z'),
      logger: { log: (message) => messages.push(message) }
    }
  );

  assert.equal(prepared.data.fields.leeftijdsgroep, 'Onder 8');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /omitted AgeClassDescription/);
});

test('contradictory Sportlink youth age class is corrected from the birth year', () => {
  const prepared = preparePerson(
    {
      PublicPersonId: 'KNVB-YOUTH-STALE',
      FirstName: 'Noud',
      LastName: 'Test',
      DateOfBirth: '2019-08-25',
      AgeClassDescription: 'Onder 7'
    },
    null,
    null,
    [],
    { referenceDate: new Date('2026-08-28T12:00:00Z') }
  );

  assert.equal(prepared.data.fields.leeftijdsgroep, 'Onder 8');
});

test('adult and special Sportlink age classes are never derived or overwritten', () => {
  const missingAdult = preparePerson(
    {
      PublicPersonId: 'KNVB-ADULT',
      FirstName: 'Ada',
      LastName: 'Adult',
      DateOfBirth: '1990-01-02'
    },
    null,
    null,
    [],
    { referenceDate: new Date('2026-08-28T12:00:00Z') }
  );
  const specialClass = preparePerson(
    {
      PublicPersonId: 'KNVB-SPECIAL',
      FirstName: 'Grace',
      LastName: 'Special',
      DateOfBirth: '2008-01-02',
      AgeClassDescription: 'Onder 23'
    },
    null,
    null,
    [],
    { referenceDate: new Date('2026-08-28T12:00:00Z') }
  );

  assert.equal(missingAdult.data.fields.leeftijdsgroep, undefined);
  assert.equal(specialClass.data.fields.leeftijdsgroep, 'Onder 23');
});
