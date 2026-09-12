const test = require('node:test');
const assert = require('node:assert/strict');
const { familyName, personNameKey } = require('../lib/person-name');
const { planRondoSponsorSync, changedPersonFields } = require('../lib/sponsit-rondo-sync');
const { buildSponsitLapostaPlan } = require('../lib/sponsit-laposta');
const { prepareCustomer } = require('../steps/prepare-freescout-customers');
const { preparePerson } = require('../steps/prepare-rondo-club-members');

const split = { first_name: 'Roel', infix: 'de', last_name: 'Bruijn', email_1: 'roel@example.test' };
const joined = { ...split, infix: '', last_name: 'de Bruijn' };
const source = {
  contact: { id: 10, type: 'company', name: 'Example BV', status: { code: 'sponsor' } },
  people: [{ id: 20, firstname: 'Roel', lastname: 'de Bruijn', email1: 'roel@example.test' }],
  addresses: []
};

test('split and joined surnames match without dropping prefixes or first-name boundaries', () => {
  for (const infix of ['de', 'van', 'van de', 'van den', "'t"]) {
    assert.equal(personNameKey({ ...split, infix }), personNameKey({ ...joined, last_name: ` ${infix.toUpperCase()}  Bruijn ` }));
  }
  assert.notEqual(personNameKey(split), personNameKey({ ...split, infix: '' }));
  assert.notEqual(personNameKey(split), personNameKey({ first_name: 'Roel de', last_name: 'Bruijn' }));
  assert.equal(familyName(split), 'de Bruijn');
  assert.equal(familyName(joined), 'de Bruijn');
});

test('Sponsit matches a split member name by email without creating or changing the member', () => {
  const plan = planRondoSponsorSync([source], [{ id: 653, fields: { ...split, person_type: 'member' } }]);
  assert.equal(plan.people.creates.length, 0);
  assert.equal(plan.people.updates.length, 0);
  assert.equal(plan.people.unchanged[0].strategy, 'email_and_identity');
  assert.equal(plan.sponsors.creates[0].desired.fields.contacts[0].person_id, 653);
});

test('Sponsit preserves an equivalent structured contact name across repeated syncs', () => {
  const person = { id: 653, fields: { ...split, person_type: 'contact' } };
  const plan = planRondoSponsorSync([source], [person]);
  assert.equal(plan.people.creates.length, 0);
  assert.equal(plan.people.updates.length, 0);
  assert.deepEqual(changedPersonFields({ ...joined, first_name: 'ROEL' }, split), {});
  assert.deepEqual(changedPersonFields({ ...joined, last_name: 'Jansen' }, split), { infix: '', last_name: 'Jansen' });
});

test('matching names do not bypass email or ambiguity checks', () => {
  const wrongEmail = planRondoSponsorSync([source], [{ id: 1, fields: { ...split, email_1: 'other@example.test' } }]);
  assert.equal(wrongEmail.people.creates.length, 1);
  const ambiguous = planRondoSponsorSync([source], [{ id: 1, fields: split }, { id: 2, fields: joined }]);
  assert.equal(ambiguous.people.creates.length, 0);
  assert.equal(ambiguous.people.quarantined[0].reason, 'multiple_rondo_matches');
  assert.equal(ambiguous.sponsors.creates[0].relationsBlocked, true);
});

test('manual and Sponsit Businessclub entries share one identity and retain the complete surname', () => {
  const people = [{ id: 653, fields: { ...split, person_type: 'member' } }];
  const sponsors = [{ id: 70, title: 'Manual BC', status: 'publish', fields: { sponsor_role: 'businessclub', contacts: [{ person_id: 653 }] } }];
  for (const records of [[], [source]]) {
    const plan = buildSponsitLapostaPlan(records, people, sponsors);
    assert.equal(plan.quarantined.length, 0);
    assert.equal(plan.members.length, 1);
    assert.equal(plan.members[0].custom_fields.achternaam, 'de Bruijn');
    assert.equal(plan.members[0].custom_fields.bedrijfsnaam, 'Manual BC');
    assert.equal(plan.members[0].custom_fields.islid, 'Ja');
  }
});

test('FreeScout exports the full surname for both layouts and preserves former-member fallback', async () => {
  const emptyDb = { prepare: () => ({ get: () => null }) };
  for (const fields of [split, joined]) {
    const customer = await prepareCustomer({ knvb_id: 'TEST', data: { fields } }, emptyDb, emptyDb);
    assert.deepEqual(customer.data, { firstName: 'Roel', lastName: 'de Bruijn' });
  }
  const trackedDb = { prepare: () => ({ get: () => ({ freescout_id: 1, data_json: JSON.stringify({ firstName: 'Roel', lastName: 'de Bruijn' }) }) }) };
  const former = await prepareCustomer({ knvb_id: 'TEST', email: 'roel@example.test', data: {} }, trackedDb, emptyDb);
  assert.deepEqual(former.data, { firstName: 'Roel', lastName: 'de Bruijn' });
});

test('Sportlink explicitly sends an empty infix to clear an old value', () => {
  for (const infix of ['de', '']) {
    const person = preparePerson({ PublicPersonId: 'TEST', FirstName: 'Roel', Infix: infix, LastName: 'Bruijn' });
    assert.equal(person.data.fields.infix, infix);
  }
});
