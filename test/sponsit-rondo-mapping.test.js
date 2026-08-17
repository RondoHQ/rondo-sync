'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRondoSponsorCompanyCandidate,
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

test('maps one Sponsit contact to a company plus a real contact relation', () => {
  const company = buildRondoSponsorCompanyCandidate(baseRecord());
  assert.equal(company.sourceKey, 'sponsit:400');
  assert.equal(company.title, 'Example BV');
  assert.equal(company.fields.sponsor_role, 'businessclub');
  assert.equal(company.fields.sponsit_contact_id, '400');
  assert.equal(company.fields.address_street_name, 'Dorpsstraat');
  assert.equal(company.fields.address_house_number, '12');
  assert.equal(company.fields.address_house_number_addition, 'A');
  assert.equal(company.people.length, 1);
  assert.equal(company.people[0].sourceKey, 'sponsit-person:900');
  assert.equal(company.people[0].fields.person_type, 'contact');
  assert.equal(company.people[0].fields.first_name, 'Jan');
  assert.equal(company.people[0].fields.gender, 'male');
  assert.equal(company.people[0].fields.birthdate, '1980-01-02');
  assert.equal(company.people[0].relation.sponsit_person_id, '900');
  assert.equal('is_sponsor' in company.people[0].fields, false);
});

test('company-only contacts create a valid company without a fake person', () => {
  const record = baseRecord();
  record.people = [];
  record.contact.tags = [];
  const company = buildRondoSponsorCompanyCandidate(record);
  assert.equal(company.title, 'Example BV');
  assert.equal(company.fields.sponsor_role, 'awc_sponsor');
  assert.deepEqual(company.people, []);
});

test('business club custom field also selects the businessclub pass', () => {
  const record = baseRecord();
  record.contact.tags = [];
  record.contact.customfields = { customfield_1: '2024-01-01' };
  assert.equal(deriveSponsorPassVariant(record), 'businessclub');
});

test('splitStreetAddress preserves unstructured addresses safely', () => {
  assert.deepEqual(splitStreetAddress('Postbus 12'), { streetName: 'Postbus', houseNumber: '12', addition: '' });
  assert.deepEqual(splitStreetAddress('Sportpark De Wijchert'), { streetName: 'Sportpark De Wijchert', houseNumber: '', addition: '' });
});
