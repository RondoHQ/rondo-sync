'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRondoSponsorCandidates,
  deriveSponsorPassVariant,
  splitStreetAddress
} = require('../lib/sponsit-rondo-mapping');

function baseRecord() {
  return {
    contact: {
      id: 400,
      type: 'company',
      name: 'Example BV',
      email1: 'office@example.test',
      status: { code: 'sponsor', name: 'Sponsor' },
      tags: [{ id: 1, name: 'BCAWC' }],
      customfields: {}
    },
    people: [{
      id: 900,
      gender: 'Dhr',
      name: 'Jan Jansen',
      firstname: 'Jan',
      lastname: 'Jansen',
      birthday: '1980-01-02T00:00:00Z',
      telephone1: '0241234567',
      email1: 'jan@example.test'
    }],
    addresses: [{
      id: 1,
      address: 'Dorpsstraat 12 A',
      postcode: '1234 AB',
      city: 'Wijchen',
      country_code: 'NL',
      is_mailing: false
    }]
  };
}

test('maps a Sponsit contact person to a reviewable Rondo sponsor candidate', () => {
  const candidates = buildRondoSponsorCandidates(baseRecord());
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceKey, 'sponsit:400:900');
  assert.equal(candidates[0].sponsorAcf.is_sponsor, true);
  assert.equal(candidates[0].sponsorAcf.sponsor_pass_variant, 'businessclub');
  assert.equal(candidates[0].sponsorAcf.company_name, 'Example BV');
  assert.equal(candidates[0].createAcf.person_type, 'contact');
  assert.equal(candidates[0].createAcf.first_name, 'Jan');
  assert.equal(candidates[0].createAcf.gender, 'male');
  assert.equal(candidates[0].createAcf.birthdate, '1980-01-02');
  assert.deepEqual(candidates[0].createAcf.addresses[0], {
    address_label: 'Hoofdadres',
    street_name: 'Dorpsstraat',
    house_number: '12',
    house_number_addition: 'A',
    postal_code: '1234 AB',
    city: 'Wijchen',
    state: '',
    country: '',
    country_code: 'NL'
  });
});

test('company-only contacts remain valid sponsor candidates', () => {
  const record = baseRecord();
  record.people = [];
  record.contact.tags = [];
  const [candidate] = buildRondoSponsorCandidates(record);
  assert.equal(candidate.sourceKey, 'sponsit:400:contact');
  assert.equal(candidate.sponsorAcf.company_name, 'Example BV');
  assert.equal(candidate.sponsorAcf.sponsor_pass_variant, 'awc_sponsor');
});

test('business club custom field also selects the businessclub pass', () => {
  const record = baseRecord();
  record.contact.tags = [];
  record.contact.customfields = { customfield_1: '2024-01-01' };
  assert.equal(deriveSponsorPassVariant(record), 'businessclub');
});

test('splitStreetAddress preserves unstructured addresses safely', () => {
  assert.deepEqual(splitStreetAddress('Postbus 12'), {
    streetName: 'Postbus',
    houseNumber: '12',
    addition: ''
  });
  assert.deepEqual(splitStreetAddress('Sportpark De Wijchert'), {
    streetName: 'Sportpark De Wijchert',
    houseNumber: '',
    addition: ''
  });
});
