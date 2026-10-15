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
  assert.deepEqual(clean.tags, { pipeline: 'people', error_code: 'unclassified_error' });
  assert.equal(clean.exception.values[0].stacktrace.frames[0].lineno, 42);
});
test('historical issue 6 causes get separate groups and safe diagnostic codes', () => {
  const event = (pipeline, step, message, line = 42) => ({
    tags: { pipeline, step },
    exception: { values: [{ type: 'Error', value: message, stacktrace: { frames: [{ filename: 'run-tracker.js', lineno: line }] } }] },
  });
  const cases = [
    ['teams', 'team-download', 'Teams request failed (401)', 'sportlink_session_expired'],
    ['teams', 'player-history-sync', 'Current Rondo team role is absent from Sportlink history; preserved for review', 'team_history_conflict'],
    ['people', 'onboarding-source-checks', 'vog: Incomplete MemberFreeFields/MemberHeader response; VOG coverage not confirmed', 'sportlink_vog_incomplete'],
    ['people', 'onboarding-source-checks', 'teams: MemberTeams panel not loaded; absence does not prove an empty membership list', 'sportlink_teams_incomplete'],
  ];
  const groups = cases.map(([pipeline, step, message, code]) => {
    const clean = sanitizeEvent(event(pipeline, step, message));
    assert.equal(clean.tags.error_code, code);
    assert.match(clean.exception.values[0].value, new RegExp(code));
    // Release, line numbers and private member identifiers must not split a known cause.
    const changed = sanitizeEvent({ ...event(pipeline, step, `${message}: PRIVATE`, 99), release: 'rondo-sync@next' });
    assert.deepEqual(changed.fingerprint, clean.fingerprint);
    assert.doesNotMatch(JSON.stringify(changed), /PRIVATE/);
    return JSON.stringify(clean.fingerprint);
  });
  assert.equal(new Set(groups).size, cases.length);
  const base = sanitizeEvent(event('people', 'onboarding-source-checks', 'Teams request failed (401)'));
  assert.notDeepEqual(base.fingerprint, sanitizeEvent(event('teams', 'onboarding-source-checks', 'Teams request failed (401)')).fingerprint);
  assert.notDeepEqual(base.fingerprint, sanitizeEvent(event('people', 'team-download', 'Teams request failed (401)')).fingerprint);
});
test('only allowlisted exception codes survive sanitization; supplied fingerprints are discarded', () => {
  const event = {
    tags: { pipeline: 'people', step: 'onboarding-source-checks', error_code: 'PRIVATE' },
    fingerprint: ['PRIVATE'],
    exception: { values: [{ type: 'Error', value: 'PRIVATE' }] },
  };
  const known = sanitizeEvent(event, { originalException: Object.assign(new Error('PRIVATE'), { code: 'ERR_SPORTLINK_SESSION_EXPIRED' }) });
  assert.equal(known.tags.error_code, 'sportlink_session_expired');
  const unknown = sanitizeEvent(event, { originalException: { code: 'SECRET' } });
  assert.equal(unknown.tags.error_code, 'unclassified_error');
  assert.ok(unknown.fingerprint.includes('{{ default }}'));
  assert.doesNotMatch(JSON.stringify([known, unknown]), /PRIVATE|SECRET/);
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
