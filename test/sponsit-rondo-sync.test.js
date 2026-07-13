const test = require('node:test');
const assert = require('node:assert/strict');
const { planRondoSponsorSync } = require('../lib/sponsit-rondo-sync');

function record(overrides = {}) {
  return {
    contact: { id: 10, type: 'company', name: 'Example BV', status: { code: 'sponsor' } },
    people: [{ id: 20, firstname: 'Jan', lastname: 'Jansen', email1: 'jan@example.test' }],
    addresses: [],
    ...overrides
  };
}

test('matches an existing member by unique email and identity without changing its person type', () => {
  const member = { id: 7, acf: { person_type: 'member', first_name: 'Jan', last_name: 'Jansen', email_1: 'JAN@example.test' } };
  const plan = planRondoSponsorSync([record()], [member]);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].strategy, 'email_and_identity');
  assert.equal(plan.updates[0].candidate.sponsorAcf.person_type, undefined);
  assert.equal(plan.creates.length, 0);
});

test('new external sponsors are created as contacts', () => {
  const plan = planRondoSponsorSync([record()], []);
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].candidate.createAcf.person_type, 'contact');
});

test('shared Sponsit emails are quarantined without a stable existing match', () => {
  const second = record({
    contact: { id: 11, type: 'company', name: 'Other BV', status: { code: 'sponsor' } },
    people: [{ id: 21, firstname: 'Piet', lastname: 'Pieters', email1: 'jan@example.test' }]
  });
  const plan = planRondoSponsorSync([record(), second], []);
  assert.equal(plan.quarantined.length, 2);
  assert.equal(plan.creates.length, 0);
});

test('only Sponsit-owned inactive sponsors are deactivated', () => {
  const owned = { id: 1, acf: { is_sponsor: true, sponsit_person_id: '99' } };
  const manual = { id: 2, acf: { is_sponsor: true } };
  const plan = planRondoSponsorSync([record()], [owned, manual]);
  assert.deepEqual(plan.deactivations.map((person) => person.id), [1]);
});
