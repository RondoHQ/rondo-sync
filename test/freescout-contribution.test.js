const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRondoContributionFeed,
  fetchRondoContributionFeed,
  formatRondoContribution
} = require('../steps/prepare-freescout-customers');
const { buildCustomFieldsPayload } = require('../steps/submit-freescout-sync');

test('indexes a valid Rondo contribution feed by person ID', () => {
  const feed = parseRondoContributionFeed({
    season: '2026-2027',
    members: [{ id: 42, invoice_status: 'paid' }]
  });

  assert.equal(feed.season, '2026-2027');
  assert.equal(feed.byPersonId.get(42).invoice_status, 'paid');
});

test('rejects an invalid Rondo contribution feed instead of clearing FreeScout fields', async () => {
  await assert.rejects(
    fetchRondoContributionFeed({}, async () => ({ body: { members: [] } })),
    /invalid response/
  );
});

test('formats Rondo installment progress and outstanding amount', () => {
  const contribution = formatRondoContribution(
    {
      invoice_status: 'sent',
      invoice_outstanding: 160,
      installment_count: 3,
      paid_installments: 1
    },
    '2026-2027'
  );

  assert.deepEqual(contribution, {
    outstanding: 160,
    status: '2026-2027 · Openstaand (1/3 termijnen betaald)'
  });
});

test('clears old contribution fields only after a successful feed omits a person', () => {
  assert.deepEqual(formatRondoContribution(null, '2026-2027'), {
    outstanding: null,
    status: null
  });
});

test('reuses FreeScout customer field IDs 7 and 8 with Rondo contribution values', () => {
  const fields = buildCustomFieldsPayload({
    union_teams: '',
    public_person_id: 'KNVB123',
    member_since: '',
    contribution_outstanding: 0,
    contribution_status: '2026-2027 · Betaald',
    relation_end: ''
  });

  assert.deepEqual(fields.slice(3, 5), [
    { id: 7, value: '0' },
    { id: 8, value: '2026-2027 · Betaald' }
  ]);
});
