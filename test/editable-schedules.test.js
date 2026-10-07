'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultSchedules, validateSchedules, loadConfig, saveConfig, PIPELINES } = require('../lib/schedule-config');
const { getNextRun, getPreviousScheduledRun, isDue, staleAfterHours } = require('../lib/schedule');
const { dispatch } = require('../lib/schedule-dispatcher');
const { migrateCrontab } = require('../scripts/install-schedule-cron');
const { parseScheduleForm } = require('../lib/schedule-form');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondo-schedules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function legacyCron() {
  return `MAILTO=ops@example.invalid
17 * * * * /usr/local/bin/unrelated-task
0 8,11,14,17 * * * /home/rondo/scripts/sync.sh people
30 7,10,13,16 * * * /home/rondo/scripts/sync.sh functions
0 1 * * 0 /home/rondo/scripts/sync.sh functions --all --with-invoice
0 8 * * * /home/rondo/scripts/sync.sh freescout
0 9 * * * /home/rondo/scripts/sync.sh conversations
0 6 * * 0 /home/rondo/scripts/sync.sh teams
0 10 * * 0 /home/rondo/scripts/sync.sh sponsit
0 3 1 * * /home/rondo/scripts/sync.sh player-history
30 23 * * 1 /home/rondo/scripts/sync.sh discipline
*/5 * * * * /home/rondo/scripts/sync.sh reverse
0 * * * * /home/rondo/scripts/sync.sh twelve --scheduled
`;
}

test('migrates all existing timings exactly, retains unrelated jobs, and is idempotent', () => {
  const migration = migrateCrontab(legacyCron(), '/home/rondo');
  assert.deepEqual(migration.schedules, defaultSchedules());
  assert.match(migration.crontab, /17 \* \* \* \* \/usr\/local\/bin\/unrelated-task/);
  assert.match(migration.crontab, /MAILTO=ops@example.invalid/);
  assert.equal(migration.crontab.match(/scheduler-tick.sh/g).length, 1);
  assert.equal(migration.crontab.match(/scripts\/sync.sh/g).length, 1);
  assert.equal(migrateCrontab(migration.crontab, '/home/rondo').crontab, migration.crontab);
});

test('imports customized timings and disabled pipelines without adding absent Twelve checks', () => {
  const result = migrateCrontab('15,45 7,19 * * * /home/rondo/scripts/sync.sh people\n', '/home/rondo');
  assert.deepEqual(result.schedules.people.times, ['07:15', '07:45', '19:15', '19:45']);
  assert.equal(result.schedules.teams.enabled, false);
  assert.doesNotMatch(result.crontab, /twelve/);
  assert.doesNotMatch(migrateCrontab(result.crontab, '/home/rondo').crontab, /twelve/);
});

test('refuses ambiguous, unknown and unsupported existing cron instead of deleting it', () => {
  assert.throws(() => migrateCrontab(legacyCron() + '0 12 * * * /home/rondo/scripts/sync.sh people\n', '/home/rondo'), /Duplicate people/);
  assert.throws(() => migrateCrontab('0 1 * * * /home/rondo/scripts/sync.sh all\n', '/home/rondo'), /Unrecognized/);
  assert.throws(() => migrateCrontab('0 1 * * 1-5 /home/rondo/scripts/sync.sh people\n', '/home/rondo'), /Unsupported/);
});

test('validates strict times, days, interval spacing, pipeline allowlist and duplicates', () => {
  for (const change of [
    s => { s.people.times = ['25:00']; }, s => { s.people.times = ['08:00', '08:00']; },
    s => { s.teams.dayOfWeek = 7; }, s => { s['player-history'].dayOfMonth = 0; },
    s => { s.reverse.intervalMinutes = 7; }, s => { s.people.command = 'unsafe'; },
    s => { s.other = s.people; }, s => { delete s.people; }
  ]) {
    const schedules = defaultSchedules(); change(schedules);
    assert.throws(() => validateSchedules(schedules));
  }
  const schedules = defaultSchedules(); schedules.people.times.reverse();
  assert.deepEqual(validateSchedules(schedules).people.times, defaultSchedules().people.times);
});

test('persisted edits drive predictions, reject stale saves, preserve unchanged timestamps and fail closed', t => {
  const file = path.join(temporary(t), 'config.json');
  const current = loadConfig(file);
  const updated = defaultSchedules(); updated.people.times = ['09:15', '21:30'];
  const saved = saveConfig(updated, current.revision, file, new Date('2026-10-07T06:00:00Z'));
  assert.equal(getNextRun('people', new Date('2026-10-07T06:00:00Z'), saved.schedules).time.toISOString(), '2026-10-07T07:15:00.000Z');
  assert.equal(getPreviousScheduledRun('people', new Date('2026-10-07T06:01:00Z'), saved.schedules), null);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => saveConfig(defaultSchedules(), current.revision, file), /another session/);
  const unchanged = saveConfig(updated, saved.revision, file);
  assert.equal(unchanged.schedules.people.changedAt, saved.schedules.people.changedAt);
  fs.writeFileSync(file, '{}');
  assert.throws(() => loadConfig(file), /version/);
});

test('daily multiple slots, weekly slots and month-end rules agree with actual dispatch', () => {
  const s = defaultSchedules();
  s.teams.times = ['06:00', '15:00'];
  assert.equal(getNextRun('teams', new Date('2026-10-11T07:00:00Z'), s).time.toISOString(), '2026-10-11T13:00:00.000Z');
  assert.equal(getPreviousScheduledRun('teams', new Date('2026-10-11T07:00:00Z'), s).time.toISOString(), '2026-10-11T04:00:00.000Z');
  s['player-history'].dayOfMonth = 31;
  const next = getNextRun('player-history', new Date('2026-02-01T00:00:00Z'), s).time;
  assert.equal(next.toISOString(), '2026-03-31T01:00:00.000Z');
  assert.equal(isDue(s['player-history'], next), true);
  assert.equal(isDue(s['player-history'], new Date('2026-02-28T02:00:00Z')), false);
});

test('midnight and both DST changes use Amsterdam wall time consistently', () => {
  const s = defaultSchedules(); s.people.times = ['00:00'];
  assert.equal(isDue(s.people, new Date('2026-10-06T22:00:00Z')), true);
  assert.equal(getNextRun('people', new Date('2026-10-06T21:59:00Z'), s).time.toISOString(), '2026-10-06T22:00:00.000Z');
  s.people.times = ['02:30'];
  assert.equal(getNextRun('people', new Date('2026-03-28T23:00:00Z'), s).time.toISOString(), '2026-03-30T00:30:00.000Z');
  assert.equal(isDue(s.people, new Date('2026-03-29T01:30:00Z')), false);
  assert.equal(isDue(s.people, new Date('2026-10-25T00:30:00Z')), true);
  assert.equal(isDue(s.people, new Date('2026-10-25T01:30:00Z')), false);
  assert.equal(getNextRun('people', new Date('2026-10-25T00:31:00Z'), s).time.toISOString(), '2026-10-26T01:30:00.000Z');
  assert.equal(getPreviousScheduledRun('people', new Date('2026-10-25T01:31:00Z'), s).time.toISOString(), '2026-10-25T00:30:00.000Z');
});

test('dispatcher launches exact due pipelines once across restarts and never catches up missed slots', async t => {
  const stateFile = path.join(temporary(t), 'state.json');
  const schedules = defaultSchedules();
  const launched = [];
  const launch = async id => launched.push(PIPELINES[id].args);
  const options = { stateFile, schedules, launch, now: new Date('2026-10-07T06:00:20Z') };
  assert.deepEqual(await dispatch(options), ['people', 'freescout', 'reverse']);
  assert.deepEqual(await dispatch(options), []);
  assert.deepEqual(launched, [['people'], ['freescout'], ['reverse']]);
  assert.deepEqual(await dispatch({ ...options, now: new Date('2026-10-07T06:01:00Z') }), []);
  assert.deepEqual(await dispatch({ ...options, now: new Date('2026-10-07T06:05:00Z') }), ['reverse']);
});

test('disabled pipelines have no predictions, no launches and no stale budget', async t => {
  const schedules = defaultSchedules(); schedules.people.enabled = false;
  assert.equal(getNextRun('people', new Date(), schedules), null);
  assert.equal(getPreviousScheduledRun('people', new Date(), schedules), null);
  assert.equal(staleAfterHours('people', new Date(), schedules), 0);
  const ids = await dispatch({ schedules, stateFile: path.join(temporary(t), 'state.json'), now: new Date('2026-10-07T06:00:00Z'), launch: async () => {} });
  assert.ok(!ids.includes('people'));
  assert.equal(staleAfterHours('player-history', new Date(), schedules), 800);
  assert.equal(staleAfterHours('reverse', new Date(), schedules), 1);
});

test('dispatch handles spawn errors, persisted-state corruption and schedules changed during a minute', async t => {
  const schedules = defaultSchedules();
  for (const s of Object.values(schedules)) s.enabled = false;
  schedules.reverse.enabled = true;
  const stateFile = path.join(temporary(t), 'state.json');
  const options = { schedules, stateFile, now: new Date('2026-10-07T06:00:20Z') };
  await assert.rejects(dispatch({ ...options, launch: async () => { throw new Error('spawn failed'); } }), /spawn failed/);
  assert.deepEqual(await dispatch({ ...options, launch: async () => {} }), ['reverse']);
  schedules.reverse.changedAt = '2026-10-07T06:05:20Z';
  assert.equal(isDue(schedules.reverse, new Date('2026-10-07T06:05:30Z')), false);
  assert.equal(isDue(schedules.reverse, new Date('2026-10-07T06:10:00Z')), true);
  fs.writeFileSync(stateFile, '{');
  await assert.rejects(dispatch({ ...options, launch: async () => {} }));
});

test('form conversion accepts comma separated times and strips hidden cadence settings', () => {
  const form = {};
  for (const [id, s] of Object.entries(defaultSchedules())) {
    form[`${id}_cadence`] = s.cadence; form[`${id}_enabled`] = 'on';
    form[`${id}_times`] = s.times?.join(', '); form[`${id}_weekday`] = String(s.dayOfWeek);
    form[`${id}_monthday`] = String(s.dayOfMonth); form[`${id}_interval`] = String(s.intervalMinutes);
  }
  assert.deepEqual(validateSchedules(parseScheduleForm(form)), defaultSchedules());
});
