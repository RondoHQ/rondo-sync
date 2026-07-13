const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SPONSIT_LAPOSTA_FIELDS,
  buildSponsitLapostaPlan,
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
  const rondoMember = { id: 1, acf: { person_type: 'member', first_name: 'Jan', last_name: 'Jansen', email_1: 'jan@example.test' } };
  const plan = buildSponsitLapostaPlan([record()], [rondoMember]);
  assert.equal(plan.members.length, 1);
  assert.equal(plan.members[0].custom_fields.businessclub, 'Ja');
  assert.equal(plan.members[0].custom_fields.islid, 'Ja');
  assert.equal(plan.members[0].custom_fields.bedrijfsnaam, 'Example BV');
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
