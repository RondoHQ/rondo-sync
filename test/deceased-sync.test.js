'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSportlinkDate,
  buildRondoDeathPlan,
  collectDeceasedEmails,
  collectActiveOwnEmails,
  planLapostaUnsubscriptions
} = require('../steps/sync-deceased-members');

test('normalizes supported Sportlink death-date formats', () => {
  assert.equal(normalizeSportlinkDate('2026-08-21'), '2026-08-21');
  assert.equal(normalizeSportlinkDate('20260821'), '2026-08-21');
  assert.equal(normalizeSportlinkDate('2026-08-21T00:00:00'), '2026-08-21');
  assert.equal(normalizeSportlinkDate(''), null);
});

test('plans a newly registered death date for a tracked inactive person', () => {
  const plan = buildRondoDeathPlan(
    [{ PublicPersonId: 'PEEX433', DateOfPassing: '2026-08-20' }],
    [{ knvb_id: 'PEEX433', rondo_club_id: 4685, date_of_passing: null }]
  );

  assert.deepEqual(plan, [{
    knvbId: 'PEEX433',
    rondoClubId: 4685,
    sourceDate: '2026-08-20',
    trackedDate: null
  }]);
});

test('does not repeatedly update an unchanged death date', () => {
  const plan = buildRondoDeathPlan(
    [{ PublicPersonId: 'PEEX433', DateOfPassing: '2026-08-20' }],
    [{ knvb_id: 'PEEX433', rondo_club_id: 4685, date_of_passing: '2026-08-20' }]
  );

  assert.deepEqual(plan, []);
});

test('clears a previously reconciled date when Sportlink corrects it', () => {
  const plan = buildRondoDeathPlan(
    [{ PublicPersonId: 'PEEX433', DateOfPassing: null }],
    [{ knvb_id: 'PEEX433', rondo_club_id: 4685, date_of_passing: '2026-08-20' }]
  );

  assert.equal(plan[0].sourceDate, null);
});

test('never clears people absent from the inactive Sportlink result', () => {
  const plan = buildRondoDeathPlan(
    [],
    [{ knvb_id: 'PEEX433', rondo_club_id: 4685, date_of_passing: '2026-08-20' }]
  );

  assert.deepEqual(plan, []);
});

test('only collects the deceased person own email fields', () => {
  const emails = collectDeceasedEmails([{
    DateOfPassing: '2026-08-20',
    Email: 'PERSON@EXAMPLE.TEST',
    EmailAlternative: 'other@example.test',
    EmailParent1: 'parent@example.test'
  }]);

  assert.deepEqual([...emails].sort(), ['other@example.test', 'person@example.test']);
});

test('only active members own addresses protect a shared Laposta subscription', () => {
  const emails = collectActiveOwnEmails([{
    Email: 'living@example.test',
    EmailAlternative: 'family@example.test',
    EmailAddressParent1: 'deceased-parent@example.test'
  }, {
    DateOfPassing: '2026-08-20',
    Email: 'deceased@example.test'
  }]);

  assert.deepEqual(
    [...emails].sort(),
    ['family@example.test', 'living@example.test']
  );
});

test('keeps a shared email subscribed when a living relation still needs it', () => {
  const remote = [
    { member_id: 'one', email: 'shared@example.test' },
    { member_id: 'two', email: 'only-deceased@example.test' }
  ];
  const deceased = new Set(['shared@example.test', 'only-deceased@example.test']);
  const desired = new Set(['shared@example.test']);

  assert.deepEqual(
    planLapostaUnsubscriptions(remote, deceased, desired).map(member => member.member_id),
    ['two']
  );
});
