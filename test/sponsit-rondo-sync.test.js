const test = require('node:test');
const assert = require('node:assert/strict');
const { planRondoSponsorSync } = require('../lib/sponsit-rondo-sync');
const { applyPlan } = require('../steps/sync-sponsit-to-rondo-club');

function record(overrides = {}) {
  return {
    contact: { id: 10, type: 'company', name: 'Example BV', status: { code: 'sponsor' } },
    people: [{ id: 20, firstname: 'Jan', lastname: 'Jansen', email1: 'jan@example.test' }],
    addresses: [],
    ...overrides
  };
}

test('matches an existing member without overwriting member-owned fields', () => {
  const member = { id: 7, fields: { person_type: 'member', first_name: 'Jan', last_name: 'Jansen', email_1: 'JAN@example.test' } };
  const plan = planRondoSponsorSync([record()], [member], []);
  assert.equal(plan.people.updates.length, 0);
  assert.equal(plan.people.unchanged.length, 1);
  assert.equal(plan.people.unchanged[0].strategy, 'email_and_identity');
  assert.equal(plan.sponsors.creates.length, 1);
  assert.equal(plan.sponsors.creates[0].desired.fields.contacts[0].person_id, 7);
});

test('new external contact and company are planned separately', () => {
  const plan = planRondoSponsorSync([record()], [], []);
  assert.equal(plan.people.creates.length, 1);
  assert.equal(plan.people.creates[0].candidate.fields.person_type, 'contact');
  assert.equal(plan.sponsors.creates.length, 1);
  assert.deepEqual(plan.sponsors.creates[0].desired.fields.contacts, []);
});

test('stable relationship source ID leaves a current company unchanged', () => {
  const person = { id: 7, fields: { person_type: 'contact', first_name: 'Jan', last_name: 'Jansen', email_1: 'jan@example.test' } };
  const sponsor = {
    id: 70,
    title: 'Example BV',
    status: 'publish',
    fields: {
      sponsor_role: 'awc_sponsor',
      sponsit_contact_id: '10',
      contacts: [{
        person_id: 7,
        contact_role: 'Contactpersoon',
        is_primary: true,
        receives_pass: true,
        is_primary_pass: true,
        sponsit_person_id: '20'
      }]
    }
  };
  const plan = planRondoSponsorSync([record()], [person], [sponsor]);
  assert.equal(plan.people.unchanged[0].strategy, 'sponsor_relationship');
  assert.equal(plan.sponsors.updates.length, 0);
  assert.equal(plan.sponsors.unchanged.length, 1);
});

test('shared Sponsit emails quarantine people but preserve both companies', () => {
  const second = record({
    contact: { id: 11, type: 'company', name: 'Other BV', status: { code: 'sponsor' } },
    people: [{ id: 21, firstname: 'Piet', lastname: 'Pieters', email1: 'jan@example.test' }]
  });
  const plan = planRondoSponsorSync([record(), second], [], []);
  assert.equal(plan.people.quarantined.length, 2);
  assert.equal(plan.people.creates.length, 0);
  assert.equal(plan.sponsors.creates.length, 2);
});

test('only Sponsit-owned missing companies are archived', () => {
  const owned = { id: 1, status: 'publish', fields: { sponsit_contact_id: '99' } };
  const manual = { id: 2, status: 'publish', fields: {} };
  const plan = planRondoSponsorSync([record()], [], [owned, manual]);
  assert.deepEqual(plan.sponsors.archives.map((sponsor) => sponsor.id), [1]);
});

test('apply creates a person before writing its company relationship', async () => {
  const requests = [];
  const plan = planRondoSponsorSync([record()], [], []);
  const result = await applyPlan(plan, {
    request: async (endpoint, method, body) => {
      requests.push([endpoint, method, body]);
      if (endpoint === 'wp/v2/people') return { body: { id: 42 } };
      return { body: { id: 84 } };
    }
  });

  assert.equal(result.peopleCreated, 1);
  assert.equal(result.companiesCreated, 1);
  assert.equal(result.relationsWritten, 1);
  assert.equal(requests[0][0], 'wp/v2/people');
  assert.equal(requests[1][0], 'rondo/v1/sponsors');
  assert.equal(requests[1][2].fields.contacts[0].person_id, 42);
  assert.equal('is_sponsor' in requests[0][2].fields, false);
});

test('archiving a company never clears or deletes its people', async () => {
  const plan = planRondoSponsorSync([], [], [{ id: 42, status: 'publish', fields: { sponsit_contact_id: '99' } }]);
  const requests = [];
  const result = await applyPlan(plan, { request: async (...args) => { requests.push(args); return { body: {} }; } });
  assert.equal(result.companiesArchived, 1);
  assert.deepEqual(requests[0].slice(0, 3), ['rondo/v1/sponsors/42', 'DELETE', null]);
});
