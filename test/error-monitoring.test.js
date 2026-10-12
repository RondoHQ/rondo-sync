const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeEvent, captureError, flush } = require('../lib/error-monitoring');
const { isSyncHealthy } = require('../lib/sync-health');
const { defaultSchedules } = require('../lib/schedule-config');

test('sync errors discard personal data and tokens while retaining diagnostic locations', () => {
  const clean = sanitizeEvent({
    release: 'rondo-sync@test', user: { email: 'PRIVATE' }, request: { headers: { Authorization: 'SECRET' } },
    breadcrumbs: [{ message: 'PRIVATE' }], extra: { member: 'PRIVATE' }, tags: { pipeline: 'people', member: 'PRIVATE' },
    exception: { values: [{ type: 'Error', value: 'PRIVATE', stacktrace: { frames: [{ filename: 'step.js?token=SECRET', lineno: 42, vars: { member: 'PRIVATE' } }] } }] },
  });
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE|SECRET/);
  assert.deepEqual(clean.tags, { pipeline: 'people' });
  assert.equal(clean.exception.values[0].stacktrace.frames[0].lineno, 42);
});
test('unconfigured monitoring does not interrupt syncs', async () => {
  assert.equal(captureError(new Error('synthetic')), undefined);
  assert.equal(await flush(), true);
});
test('health detects a stopped interval pipeline despite recent schedule slots', () => {
  const schedules = defaultSchedules();
  const now = new Date('2026-10-12T12:00:00Z');
  const pipeline = { name: 'reverse', previousRun: { started_at: '2026-10-12T10:00:00Z', outcome: 'success' } };
  assert.equal(isSyncHealthy([pipeline], schedules, now), false);
  pipeline.previousRun.started_at = '2026-10-12T11:55:00Z';
  assert.equal(isSyncHealthy([pipeline], schedules, now), true);
  pipeline.previousRun.outcome = 'partial';
  assert.equal(isSyncHealthy([pipeline], schedules, now), true);
  pipeline.previousRun.outcome = 'failure';
  assert.equal(isSyncHealthy([pipeline], schedules, now), false);
});
test('health allows disabled schedules and a changed schedule before its first due slot', () => {
  const schedules = defaultSchedules();
  const now = new Date('2026-10-12T12:00:00Z');
  const pipeline = { name: 'reverse', previousRun: null };
  schedules.reverse.enabled = false;
  assert.equal(isSyncHealthy([pipeline], schedules, now), true);
  schedules.reverse.enabled = true;
  schedules.reverse.changedAt = now.toISOString();
  assert.equal(isSyncHealthy([pipeline], schedules, now), true);
  delete schedules.reverse.changedAt;
  assert.equal(isSyncHealthy([pipeline], schedules, now), false);
});
