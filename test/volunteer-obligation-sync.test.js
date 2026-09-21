const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPersonObligationValues, buildRecipientObligationMaps, resolveLapostaObligationValue } = require('../lib/volunteer-obligation-sync');
const counts = (required, planned = 0, completed = 0) => ({
  vrijwilligersplicht: required, vrijwilligersingepland: planned, vrijwilligersafgerond: completed
});
const unit = (personIds, required = 2, planned = 0, completed = 0, exempt = false) => ({
  person_ids: personIds, required_count: required, pending_count: planned,
  completed_count: completed, remaining: Math.max(0, required - completed), is_exempt: exempt
});

test('total requirement stays constant after planning, completion, and extra work', () => {
  for (const [planned, completed] of [[0, 0], [2, 0], [1, 1], [0, 2], [1, 4]]) {
    assert.deepEqual(buildPersonObligationValues([unit([10], 2, planned, completed)]).get('10'), counts(2, planned, completed));
  }
});

test('family progress is shared once per person and combines with personal obligations', () => {
  const values = buildPersonObligationValues([
    unit([10, 10, 11], 3, 1, 1), unit([10], 2, 0, 2), unit([20], 2, 1, 0, true),
    unit([30], 2, 1, 0, true), unit([30], 3, 0, 1)
  ]);
  assert.deepEqual(values.get('10'), counts(5, 1, 3));
  assert.deepEqual(values.get('11'), counts(3, 1, 1));
  assert.deepEqual(values.get('20'), counts(-1, 1, 0));
  assert.deepEqual(values.get('30'), counts(3, 1, 1));
});

test('incomplete or malformed source data fails rather than publishing zeroes', () => {
  assert.throws(() => buildPersonObligationValues([{ person_ids: [10], remaining: 2 }]), /missing is_exempt/);
  for (const field of ['required_count', 'pending_count', 'completed_count']) {
    for (const invalid of [undefined, null, -1, 1.5, '2', NaN]) {
      assert.throws(() => buildPersonObligationValues([{ ...unit([10]), [field]: invalid }]), new RegExp(`invalid ${field}`));
    }
  }
});

test('recipient maps retain exemption sentinel and normalized parent identities', () => {
  const maps = buildRecipientObligationMaps(
    new Map([['101', counts(2, 1, 1)], ['202', counts(-1, 0, 1)]]),
    [{ knvb_id: 'A', rondo_club_id: 101 }, { knvb_id: 'B', rondo_club_id: 999 }],
    [{ email: 'Ouder@Example.nl', rondo_club_id: 202 }, { email: 'geenplicht@example.nl', rondo_club_id: 998 }]
  );
  assert.deepEqual(maps.byKnvbId.get('A'), counts(2, 1, 1));
  assert.deepEqual(maps.byKnvbId.get('B'), counts(-1));
  assert.deepEqual(maps.byParentEmail.get('ouder@example.nl'), counts(-1, 0, 1));
  assert.deepEqual(maps.byParentEmail.get('geenplicht@example.nl'), counts(-1));
});

test('parent relations prefer parent progress and fall back to child family progress', () => {
  const maps = { byKnvbId: new Map([['CHILD', counts(3, 1, 1)]]), byParentEmail: new Map([['ouder@example.nl', counts(5, 2, 1)]]) };
  assert.deepEqual(resolveLapostaObligationValue(maps, { knvbId: 'CHILD', email: 'Ouder@Example.nl', emailType: 'parent1' }), counts(5, 2, 1));
  assert.deepEqual(resolveLapostaObligationValue(maps, { knvbId: 'CHILD', email: 'unknown@example.nl', emailType: 'parent2' }), counts(3, 1, 1));
  assert.deepEqual(resolveLapostaObligationValue(maps, { knvbId: 'UNKNOWN', emailType: 'primary' }), counts(-1));
  assert.deepEqual(resolveLapostaObligationValue(maps, { knvbId: 'CHILD', emailType: 'primary' }), counts(3, 1, 1));
  assert.equal(resolveLapostaObligationValue(null, { knvbId: 'CHILD', emailType: 'primary' }), undefined);
});
