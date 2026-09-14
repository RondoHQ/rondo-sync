const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyParentSources } = require('../steps/sync-onboarding-sources');

function fixture(fields = {}) {
  const records = {
    100: { id: 100, fields: { relationships: [{ related_person_id: 200, relationship_type_id: 2 }] } },
    200: { id: 200, fields: {
      email_1: 'parent@example.test',
      relationships: [{ related_person_id: 100, relationship_type_id: 3 }],
      ...fields
    } }
  };
  return {
    records,
    args: {
      personId: 100,
      general: { EmailAddressParent1: ' PARENT@example.test ', EmailAddressParent2: '' },
      saved: { errors: [], results: [{ email: 'parent@example.test', id: 200, action: 'updated' }] },
      request: async route => ({ body: records[route.split('/').pop()] })
    }
  };
}

test('confirmed parent aliases retain independently managed contact details', async () => {
  for (const ownership of [{ knvb_id: 'PARENT1', former_member: false }, { person_type: 'contact' }, { is_sponsor: true }]) {
    const { args } = fixture({ ...ownership, email_1: 'club@example.test' });
    assert.deepEqual(await verifyParentSources(args), { success: true });
  }
});

test('standalone and former-member parents must confirm the source email', async () => {
  for (const ownership of [{}, { knvb_id: 'PARENT1', former_member: true }]) {
    const { args, records } = fixture({ ...ownership, email_1: 'stale@example.test' });
    await assert.rejects(verifyParentSources(args), /Stored parent addresses/);
    records[200].fields.email_2 = 'parent@example.test';
    assert.deepEqual(await verifyParentSources(args), { success: true });
  }
});

test('managed contact ownership never bypasses a missing mapping or reciprocal link', async () => {
  for (const breakProof of [
    ({ args }) => { args.saved.results = []; },
    ({ args }) => { args.saved.results[0].id = 999; },
    ({ args }) => { args.saved.results[0].action = 'skipped'; },
    ({ records }) => { records[100].fields.relationships = []; },
    ({ records }) => { records[200].fields.relationships = []; },
    ({ records }) => { records[200].fields.relationships[0].relationship_type_id = 4; }
  ]) {
    const context = fixture({ knvb_id: 'PARENT1', email_1: 'club@example.test' });
    breakProof(context);
    await assert.rejects(verifyParentSources(context.args), /Stored parent relationships/);
  }
});

test('an unconfirmed second parent is not covered by the first managed parent', async () => {
  const { args } = fixture({ knvb_id: 'PARENT1' });
  args.general.EmailAddressParent2 = 'other@example.test';
  await assert.rejects(verifyParentSources(args), /Stored parent relationships/);
});

test('empty parent sources and failed saves still fail closed', async () => {
  const { args, records } = fixture();
  args.general.EmailAddressParent1 = '';
  args.saved.results = [];
  await assert.rejects(verifyParentSources(args), /Stored parent addresses/);
  records[100].fields.relationships = [];
  assert.deepEqual(await verifyParentSources(args), { success: true });
  args.saved.errors.push({ message: 'Write failed' });
  await assert.rejects(verifyParentSources(args), /could not be saved/);
});
