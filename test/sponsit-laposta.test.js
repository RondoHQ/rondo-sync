const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPONSIT_LAPOSTA_FIELDS,
  buildSponsitLapostaPlan,
  isValidLapostaEmail,
  lapostaMemberMatches,
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
  personal.contact.type = 'person';
  personal.contact.name = 'Jan Jansen';
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
  const plan = buildSponsitLapostaPlan([record(), other]);
  assert.equal(plan.members.length, 0);
  assert.equal(plan.quarantined.length, 2);
});

test('requires the complete dedicated Laposta schema', () => {
  const fields = SPONSIT_LAPOSTA_FIELDS.slice(0, -1).map((custom_name) => ({ custom_name }));
  assert.deepEqual(validateLapostaFields(fields), ['islid']);
});
