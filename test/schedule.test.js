'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getNextRun, getPreviousScheduledRun, PIPELINE_SCHEDULES } = require('../lib/schedule');

test('Sponsit is scheduled weekly on Sunday at 10:00 Amsterdam time', () => {
  assert.deepEqual(PIPELINE_SCHEDULES.sponsit, {
    times: [{ hour: 10, minute: 0 }],
    dayOfWeek: 0,
    label: 'Weekly (Sun)'
  });

  const saturday = new Date('2026-07-18T12:00:00.000Z');
  assert.equal(getNextRun('sponsit', saturday).time.toISOString(), '2026-07-19T08:00:00.000Z');

  const sundayAfterRun = new Date('2026-07-19T09:00:00.000Z');
  assert.equal(
    getPreviousScheduledRun('sponsit', sundayAfterRun).time.toISOString(),
    '2026-07-19T08:00:00.000Z'
  );
});
