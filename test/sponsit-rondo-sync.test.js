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
      sponsor_type: 'organization',
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

test('shared Sponsit emails with different names remain separate stable people', () => {
  const second = record({
    contact: { id: 11, type: 'company', name: 'Other BV', status: { code: 'sponsor' } },
    people: [{ id: 21, firstname: 'Piet', lastname: 'Pieters', email1: 'jan@example.test' }]
  });
  const plan = planRondoSponsorSync([record(), second], [], []);
  assert.equal(plan.people.quarantined.length, 0);
  assert.equal(plan.people.creates.length, 2);
  assert.equal(plan.sponsors.creates.length, 2);
});

test('same person identity across sponsors resolves to one person', () => {
  const second = record({
    contact: { id: 11, type: 'company', name: 'Other BV', status: { code: 'sponsor' } },
    people: [{ id: 21, firstname: 'Jan', lastname: 'Jansen', email1: 'jan@example.test' }]
  });
  const plan = planRondoSponsorSync([record(), second], [], []);
  assert.equal(plan.people.creates.length, 1);
  assert.equal(plan.people.creates[0].aliases.length, 2);
  const relations = plan.companies.flatMap((company) => company.people.map((person) => person.relation));
  assert.equal(relations.filter((relation) => relation.is_primary_pass).length, 1);
});

test('WordPress title entity encoding does not trigger a sponsor update', () => {
  const source = record({
    contact: { id: 10, type: 'company', name: "Example & Partner's", status: { code: 'sponsor' } }
  });
  const person = { id: 7, fields: { person_type: 'contact', first_name: 'Jan', last_name: 'Jansen', email_1: 'jan@example.test' } };
  const sponsor = {
    id: 70,
    title: 'Example &#038; Partner&#8217;s',
    status: 'publish',
    fields: {
      sponsor_type: 'organization',
      sponsor_role: 'awc_sponsor',
      sponsit_contact_id: '10',
      website: '',
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

  const plan = planRondoSponsorSync([source], [person], [sponsor]);
  assert.equal(plan.sponsors.updates.length, 0);
  assert.equal(plan.sponsors.unchanged.length, 1);
});

test('only Sponsit-owned missing companies are archived', () => {
  const owned = { id: 1, status: 'publish', fields: { sponsit_contact_id: '99' } };
  const manual = { id: 2, status: 'publish', fields: {} };
  const plan = planRondoSponsorSync([record()], [], [owned, manual]);
  assert.deepEqual(plan.sponsors.archives.map((sponsor) => sponsor.id), [1]);
});

test('apply creates a sponsor before atomically creating its person relation', async () => {
  const requests = [];
  const plan = planRondoSponsorSync([record()], [], []);
  const result = await applyPlan(plan, {
    request: async (endpoint, method, body) => {
      requests.push([endpoint, method, body]);
      if (endpoint === 'rondo/v1/sponsors') return { body: { id: 84 } };
      if (endpoint === 'rondo/v1/sponsors/84/contacts') {
        return { body: { fields: { contacts: [{ person_id: 42, sponsit_person_id: '20' }] } } };
      }
      return { body: {} };
    }
  });

  assert.equal(result.peopleCreated, 1);
  assert.equal(result.companiesCreated, 1);
  assert.equal(result.relationsWritten, 1);
  assert.equal(requests[0][0], 'rondo/v1/sponsors');
  assert.equal(requests[1][0], 'rondo/v1/sponsors/84/contacts');
  assert.equal(requests[2][0], 'rondo/v1/sponsors/84');
  assert.equal(requests[2][2].fields.contacts[0].person_id, 42);
  assert.equal(requests.some(([endpoint]) => endpoint === 'wp/v2/people'), false);
});

test('failed atomic contact creation cannot leave a standalone person', async () => {
  const requests = [];
  const plan = planRondoSponsorSync([record()], [], []);
  const result = await applyPlan(plan, {
    request: async (endpoint, method, body) => {
      requests.push([endpoint, method, body]);
      if (endpoint === 'rondo/v1/sponsors') return { body: { id: 84 } };
      throw new Error('Contact relation failed');
    }
  });
  assert.equal(result.peopleCreated, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(requests.some(([endpoint]) => endpoint === 'wp/v2/people'), false);
});

test('logo import downloads from Sponsit and uploads only after the sponsor exists', async () => {
  const source = record();
  source.contact.logo = { id: 117280, filename: 'Example logo.jpg' };
  const plan = planRondoSponsorSync([source], [], []);
  const calls = [];
  const result = await applyPlan(plan, {
    request: async (endpoint) => {
      calls.push(endpoint);
      if (endpoint === 'rondo/v1/sponsors') return { body: { id: 84 } };
      if (endpoint === 'rondo/v1/sponsors/84/contacts') {
        return { body: { fields: { contacts: [{ person_id: 42, sponsit_person_id: '20' }] } } };
      }
      return { body: {} };
    },
    downloadSponsorLogo: async (logo) => {
      calls.push(`download:${logo.sourceId}`);
      return { buffer: Buffer.from('image'), contentType: 'image/jpeg' };
    },
    uploadSponsorLogo: async (sponsorId, logo) => {
      calls.push(`upload:${sponsorId}:${logo.sourceId}`);
      return { body: { logo_attachment_id: 99 } };
    }
  });

  assert.equal(result.logosImported, 1);
  assert.ok(calls.indexOf('rondo/v1/sponsors') < calls.indexOf('download:117280'));
  assert.ok(calls.includes('upload:84:117280'));
});

test('matching Sponsit logo ID and an attached logo prevent a redundant import', () => {
  const source = record();
  source.contact.logo = { id: 117280, filename: 'Example logo.jpg' };
  const sponsor = {
    id: 84,
    title: 'Example BV',
    status: 'publish',
    logo_attachment_id: 99,
    fields: {
      sponsor_type: 'organization',
      sponsor_role: 'awc_sponsor',
      sponsit_contact_id: '10',
      sponsit_logo_id: '117280',
      website: '',
      contacts: []
    }
  };
  const plan = planRondoSponsorSync([source], [], [sponsor]);
  const item = [...plan.sponsors.updates, ...plan.sponsors.unchanged][0];
  assert.equal(item.logoNeedsImport, false);
});

test('an existing manual logo is not overwritten by Sponsit', () => {
  const source = record();
  source.contact.logo = { id: 117280, filename: 'Example logo.jpg' };
  const sponsor = {
    id: 84,
    title: 'Example BV',
    status: 'publish',
    logo_attachment_id: 99,
    fields: {
      sponsor_type: 'organization',
      sponsor_role: 'awc_sponsor',
      sponsit_contact_id: '10',
      website: '',
      contacts: []
    }
  };
  const plan = planRondoSponsorSync([source], [], [sponsor]);
  const item = [...plan.sponsors.updates, ...plan.sponsors.unchanged][0];
  assert.equal(item.logoNeedsImport, false);
});

test('archiving a company never clears or deletes its people', async () => {
  const plan = planRondoSponsorSync([], [], [{ id: 42, status: 'publish', fields: { sponsit_contact_id: '99' } }]);
  const requests = [];
  const result = await applyPlan(plan, { request: async (...args) => { requests.push(args); return { body: {} }; } });
  assert.equal(result.companiesArchived, 1);
  assert.deepEqual(requests[0].slice(0, 3), ['rondo/v1/sponsors/42', 'DELETE', null]);
});
