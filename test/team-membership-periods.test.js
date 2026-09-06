'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTeamMembershipSeasons: normalize } = require('../lib/team-membership-periods');
const { reconcilePlayerHistory } = require('../steps/submit-rondo-club-player-history');

const now = new Date('2026-09-06T12:00:00Z');
const old = { PublicTeamId: 'old-team', TeamName: 'AWC O15-4JM', FunctionDescription: 'Teammanager', RelationStart: '2025-08-27', RelationEnd: '', SeasonDescription: "seizoen 2025/'26" };

test('an undated old-season role closes at season end and preserves the input', () => {
  const [row] = normalize([old], now);
  assert.equal(row.RelationEnd, '2026-06-30');
  assert.equal(old.RelationEnd, '');
});

test('current, future, unknown and contradictory seasons remain unchanged', () => {
  for (const season of ["seizoen 2026/'27", "seizoen 2027/'28", '', 'unknown', "2025/'27"]) {
    const row = { ...old, SeasonDescription: season };
    assert.deepEqual(normalize([row], now), [row]);
  }
  const lateStart = { ...old, RelationStart: '2026-07-01' };
  assert.deepEqual(normalize([lateStart], now), [lateStart]);
});

test('explicit end dates remain authoritative even outside the season', () => {
  for (const end of ['2026-07-26', '2025-12-01']) {
    const row = { ...old, RelationEnd: end };
    assert.deepEqual(normalize([row], now), [row]);
  }
});

test('season rollover follows Amsterdam midnight and consecutive year formats', () => {
  assert.equal(normalize([old], new Date('2026-06-30T21:59:59Z'))[0].RelationEnd, '');
  assert.equal(normalize([old], new Date('2026-06-30T22:00:00Z'))[0].RelationEnd, '2026-06-30');
  for (const season of ['2025/2026', '2025-2026', 'seizoen 2025/’26']) {
    assert.equal(normalize([{ ...old, SeasonDescription: season }], now)[0].RelationEnd, '2026-06-30');
  }
});

test('a continuing current-season stint wins over an inferred old end in either order', () => {
  const current = { ...old, SeasonDescription: "seizoen 2026/'27" };
  assert.deepEqual(normalize([old, current], now), [current]);
  assert.deepEqual(normalize([current, old], now), [current]);
});

test('a dated copy wins over an inferred end and multiple old seasons use the latest', () => {
  const dated = { ...old, RelationEnd: '2026-07-26' };
  assert.deepEqual(normalize([old, dated], now), [dated]);
  const earlier = { ...old, RelationStart: '2024-08-27', SeasonDescription: "seizoen 2024/'25" };
  const later = { ...earlier, SeasonDescription: "seizoen 2025/'26" };
  assert.deepEqual(normalize([earlier, later], now), [{ ...later, RelationEnd: '2026-06-30' }]);
});

test('a distinct current stint does not erase the old period', () => {
  const current = { ...old, RelationStart: '2026-08-01', SeasonDescription: "seizoen 2026/'27" };
  const rows = normalize([old, current], now);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].RelationEnd, '2026-06-30');
  assert.equal(rows[1].RelationEnd, '');
});

test('reimport closes the stale role once and preserves unrelated and ended history', () => {
  const [row] = normalize([old], now);
  const source = [{ team_id: 2632, job_title: row.FunctionDescription, start_date: row.RelationStart, end_date: row.RelationEnd, is_current: !row.RelationEnd }];
  const previous = { team_id: 2632, job_title: 'Teammanager', start_date: null, end_date: '2026-07-05', is_current: false };
  const unrelated = { team_id: 2662, job_title: 'Jeugdbegeleid(st)er', start_date: '2025-08-27', end_date: null, is_current: true };
  const result = reconcilePlayerHistory([previous, { ...source[0], end_date: null, is_current: true }, unrelated], source);
  assert.equal(result.reconciled, 1);
  assert.equal(result.created, 0);
  assert.deepEqual(result.workHistory[0], previous);
  assert.deepEqual(result.workHistory[2], unrelated);
  const repeated = reconcilePlayerHistory(result.workHistory, source);
  assert.equal(repeated.created + repeated.reconciled, 0);
});
