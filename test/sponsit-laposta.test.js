const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPONSIT_LAPOSTA_FIELDS,
  buildSponsitLapostaPlan,
  isValidLapostaEmail,
  lapostaMemberMatches,
  shouldUnsubscribeSponsitMember,
  validateLapostaFields
} = require('../lib/sponsit-laposta');

function record(email = 'jan@example.test') {
  return {
    contact: { id: 10, type: 'company', name: 'Example BV', status: { code: 'sponsor' }, tags: [{ name: 'BCAWC' }] },
    people: [{ id: 20, firstname: 'Jan', lastname: 'Jansen', email1: email }],
    addresses: []
  };
}

test('builds the requested Businessclub and member fields', () => {
  const rondoMember = { id: 1, fields: { person_type: 'member', first_name: 'Jan', last_name: 'Jansen', email_1: 'jan@example.test' } };
  const plan = buildSponsitLapostaPlan([record()], [rondoMember]);
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].custom_fields.businessclub, 'Ja');
  assert.equal(plan.members[0].custom_fields.islid, 'Ja');
  assert.equal(plan.members[0].custom_fields.bedrijfsnaam, 'Example BV');
});

test('uses the person name when the mandatory company field has no company', () => {
  const personal = record();
  personal.contact = {
    ...personal.contact,
    type: 'person',
    name: 'Jan Jansen',
    firstname: 'Jan',
    lastname: 'Jansen',
    email1: 'jan@example.test'
  };
  personal.people = [];
  const plan = buildSponsitLapostaPlan([personal]);
  assert.equal(plan.members[0].custom_fields.bedrijfsnaam, 'Jan Jansen');
});

test('quarantines addresses Laposta cannot accept', () => {
  assert.equal(isValidLapostaEmail('valid@example.test'), true);
  assert.equal(isValidLapostaEmail('invalid address@example.test'), false);
  const plan = buildSponsitLapostaPlan([record('invalid-address')]);
  assert.equal(plan.members.length, 0);
  assert.equal(plan.quarantined[0].reason, 'invalid_email');
});

test('detects already-current Laposta custom fields', () => {
  const desired = {
    email: 'jan@example.test',
    custom_fields: { businessclub: 'Ja', islid: 'Ja' }
  };
  assert.equal(lapostaMemberMatches({
    email: 'JAN@example.test',
    custom_fields: { businessclub: 'Ja', islid: 'Ja' }
  }, desired), true);
  assert.equal(lapostaMemberMatches({
    email: 'jan@example.test',
    custom_fields: { businessclub: 'Nee', islid: 'Ja' }
  }, desired), false);
});

test('quarantines duplicate shared email addresses', () => {
  const other = record();
  other.contact.id = 11;
  other.people[0].id = 21;
  other.people[0].firstname = 'Piet';
  other.people[0].lastname = 'Pieters';
  const plan = buildSponsitLapostaPlan([record(), other]);
  assert.equal(plan.members.length, 0);
  assert.equal(plan.quarantined.length, 2);
});

test('deduplicates one person registered under multiple sponsors', () => {
  const other = record();
  other.contact.id = 11;
  other.people[0].id = 21;
  const plan = buildSponsitLapostaPlan([record(), other]);
  assert.equal(plan.members.length, 1);
  assert.equal(plan.quarantined.length, 0);
});

test('includes a manually managed Rondo Businessclub member', () => {
  const rondoMember = { id: 7, fields: { person_type: 'member', first_name: 'Tiny', last_name: 'Janssen', email_1: 'tiny@example.test' } };
  const manualBusinessclub = {
    id: 71,
    title: 'Leden van verdienste',
    status: 'publish',
    fields: {
      sponsor_role: 'businessclub',
      sponsit_contact_id: '',
      contacts: [{ person_id: 7, receives_pass: true, is_primary_pass: true }]
    }
  };

  const plan = buildSponsitLapostaPlan([], [rondoMember], [manualBusinessclub]);
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].custom_fields.businessclub, 'Ja');
  assert.equal(plan.members[0].custom_fields.sponsorvariant, 'Businessclub AWC');
  assert.equal(plan.members[0].custom_fields.bedrijfsnaam, 'Leden van verdienste');
  assert.equal(plan.members[0].custom_fields.islid, 'Ja');
  assert.equal(plan.members[0].custom_fields.sponsitcontactid, '');
});

test('manual Businessclub membership overrides a Sponsit sponsor without losing source IDs', () => {
  const sponsitRecord = record();
  sponsitRecord.contact.tags = [];
  const rondoMember = { id: 7, fields: { person_type: 'member', first_name: 'Jan', last_name: 'Jansen', email_1: 'jan@example.test' } };
  const manualBusinessclub = {
    id: 71,
    title: 'Leden van verdienste',
    status: 'publish',
    fields: {
      sponsor_role: 'businessclub',
      sponsit_contact_id: '',
      contacts: [{ person_id: 7, receives_pass: true, is_primary_pass: true }]
    }
  };

  const plan = buildSponsitLapostaPlan([sponsitRecord], [rondoMember], [manualBusinessclub]);
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].custom_fields.businessclub, 'Ja');
  assert.equal(plan.members[0].custom_fields.bedrijfsnaam, 'Leden van verdienste');
  assert.equal(plan.members[0].custom_fields.sponsitcontactid, '10');
  assert.equal(plan.members[0].custom_fields.sponsitpersoonid, '20');
});

test('requires the complete dedicated Laposta schema', () => {
  const fields = SPONSIT_LAPOSTA_FIELDS.slice(0, -1).map((custom_name) => ({ custom_name }));
  assert.deepEqual(validateLapostaFields(fields), ['islid']);
});

test('only stale person-backed rows are automatically unsubscribed', () => {
  const desiredEmails = new Set(['current@example.test']);
  const legacyCompany = {
    email: 'company@example.test',
    custom_fields: { sponsitcontactid: '10', sponsitpersoonid: '' }
  };
  const formerPerson = {
    email: 'former@example.test',
    custom_fields: { sponsitcontactid: '10', sponsitpersoonid: '20' }
  };
  const currentPerson = {
    email: 'current@example.test',
    custom_fields: { sponsitcontactid: '10', sponsitpersoonid: '21' }
  };

  assert.equal(shouldUnsubscribeSponsitMember(legacyCompany, desiredEmails), false);
  assert.equal(shouldUnsubscribeSponsitMember(formerPerson, desiredEmails), true);
  assert.equal(shouldUnsubscribeSponsitMember(currentPerson, desiredEmails), false);
});
