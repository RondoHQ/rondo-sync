const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPersonObligationValues,
  buildRecipientObligationMaps,
  resolveLapostaObligationValue
} = require('../lib/volunteer-obligation-sync');

test('buildPersonObligationValues encodes active, completed, exempt, and combined duties', () => {
  const values = buildPersonObligationValues([
    { person_ids: [10], remaining: 2, is_exempt: false },
    { person_ids: [20], remaining: 0, is_exempt: false },
    { person_ids: [30], remaining: 2, is_exempt: true },
    { person_ids: [40], remaining: 2, is_exempt: true },
    { person_ids: [40], remaining: 1, is_exempt: false },
    { person_ids: [50, 51], remaining: 3, is_exempt: false },
    { person_ids: [10], remaining: 1, is_exempt: false }
  ]);

  assert.equal(values.get('10'), 3);
  assert.equal(values.get('20'), 0);
  assert.equal(values.get('30'), -1);
  assert.equal(values.get('40'), 1);
  assert.equal(values.get('50'), 3);
  assert.equal(values.get('51'), 3);
});

test('buildPersonObligationValues refuses an old API response without exemption data', () => {
  assert.throws(
    () => buildPersonObligationValues([{ person_ids: [10], remaining: 2 }]),
    /missing is_exempt/
  );
});

test('recipient maps use -1 for people outside the obligation target group', () => {
  const personValues = new Map([['101', 2], ['202', -1]]);
  const maps = buildRecipientObligationMaps(
    personValues,
    [
      { knvb_id: 'A', rondo_club_id: 101 },
      { knvb_id: 'B', rondo_club_id: 999 }
    ],
    [
      { email: 'Ouder@Example.nl', rondo_club_id: 202 },
      { email: 'geenplicht@example.nl', rondo_club_id: 998 }
    ]
  );

  assert.equal(maps.byKnvbId.get('A'), 2);
  assert.equal(maps.byKnvbId.get('B'), -1);
  assert.equal(maps.byParentEmail.get('ouder@example.nl'), -1);
  assert.equal(maps.byParentEmail.get('geenplicht@example.nl'), -1);
});

test('parent relations prefer the parent value and fall back to the child value', () => {
  const maps = {
    byKnvbId: new Map([['CHILD', 3]]),
    byParentEmail: new Map([['ouder@example.nl', 1]])
  };

  assert.equal(resolveLapostaObligationValue(maps, {
    knvbId: 'CHILD',
    email: 'Ouder@Example.nl',
    emailType: 'parent1'
  }), 1);
  assert.equal(resolveLapostaObligationValue(maps, {
    knvbId: 'CHILD',
    email: 'onbekend@example.nl',
    emailType: 'parent2'
  }), 3);
  assert.equal(resolveLapostaObligationValue(maps, {
    knvbId: 'UNKNOWN',
    email: 'onbekend@example.nl',
    emailType: 'primary'
  }), -1);
  assert.equal(resolveLapostaObligationValue(maps, {
    knvbId: 'CHILD',
    email: 'kind@example.nl',
    emailType: 'primary'
  }), 3);
  assert.equal(resolveLapostaObligationValue(null, {
    knvbId: 'CHILD',
    email: 'kind@example.nl',
    emailType: 'primary'
  }), undefined);
});
