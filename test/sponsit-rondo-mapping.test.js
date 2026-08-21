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
      website: 'www.example.test',
      logo: { id: 117280, filename: 'Example logo.jpg' },
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
  assert.equal(company.fields.sponsor_type, 'organization');
  assert.equal(company.fields.sponsor_role, 'businessclub');
  assert.equal(company.fields.sponsit_contact_id, '400');
  assert.equal(company.fields.website, 'https://www.example.test/');
  assert.deepEqual(company.logo, {
    sourceId: '117280',
    filename: 'Example logo.jpg',
    relativeUrl: '/uploads/117280/preview/Example%20logo.jpg'
  });
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

test('maps a personal Sponsit sponsor to a sponsor plus its own person relation', () => {
  const record = baseRecord();
  record.contact = {
    ...record.contact,
    type: 'person',
    name: 'Piet Sponsor',
    firstname: 'Piet',
    lastname: 'Sponsor',
    email1: 'piet@example.test'
  };
  record.people = [];
  const sponsor = buildRondoSponsorCompanyCandidate(record);
  assert.equal(sponsor.fields.sponsor_type, 'person');
  assert.equal(sponsor.people.length, 1);
  assert.equal(sponsor.people[0].sourceKey, 'sponsit-contact-person:400');
  assert.equal(sponsor.people[0].relation.contact_role, 'Sponsor');
  assert.equal(sponsor.people[0].relation.sponsit_person_id, 'contact:400');
  assert.equal(sponsor.people[0].fields.email_1, 'piet@example.test');
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

test('contact values use the same email and phone normalization as Rondo', () => {
  const source = baseRecord();
  source.people[0].email1 = 'JAN@Example.Test';
  source.people[0].email2 = 'SECOND@Example.Test';
  source.people[0].telephone1 = '06-12 34 56 78';
  source.people[0].telephone2 = '0032 (0) 12 34 56';
  const person = buildRondoSponsorCompanyCandidate(source).people[0];

  assert.equal(person.fields.email_1, 'jan@example.test');
  assert.equal(person.fields.email_2, 'second@example.test');
  assert.equal(person.fields.telephone_1, '+31612345678');
  assert.equal(person.fields.telephone_2, '+320123456');
});

test('invalid or unsafe sponsor websites are not imported', () => {
  const record = baseRecord();
  record.contact.website = 'javascript:alert(1)';
  assert.equal(buildRondoSponsorCompanyCandidate(record).fields.website, '');
});
