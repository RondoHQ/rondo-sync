'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withDisplayMetrics, withDisplayStepMetrics } = require('../lib/dashboard-metrics');

test('People run totals use authoritative Rondo Club person counts', () => {
  const run = withDisplayMetrics({
    pipeline: 'people',
    total_created: 2345,
    total_updated: 11,
    total_skipped: 1589,
    summary_json: JSON.stringify({
      rondoClub: { created: 0, updated: 7, skipped: 1553 }
    })
  });

  assert.equal(run.display_created, 0);
  assert.equal(run.display_updated, 7);
  assert.equal(run.display_skipped, 1553);
  assert.equal(run.display_metric_label, 'People');
  assert.equal(run.total_created, 2345, 'stored audit total remains untouched');
});

test('People internal steps display downloaded and prepared rows as processed', () => {
  const steps = withDisplayStepMetrics('people', [
    { step_name: 'sportlink-download', created_count: 1085 },
    { step_name: 'laposta-prepare', created_count: 1258 },
    { step_name: 'rondo-club-sync', created_count: 0 },
    { step_name: 'photo-download', created_count: 1 },
    { step_name: 'photo-upload', created_count: 1 }
  ]);

  assert.deepEqual(
    steps.map(({ step_name, processed_count, created_count }) => ({ step_name, processed_count, created_count })),
    [
      { step_name: 'sportlink-download', processed_count: 1085, created_count: 0 },
      { step_name: 'laposta-prepare', processed_count: 1258, created_count: 0 },
      { step_name: 'rondo-club-sync', processed_count: 0, created_count: 0 },
      { step_name: 'photo-download', processed_count: 1, created_count: 0 },
      { step_name: 'photo-upload', processed_count: 0, created_count: 1 }
    ]
  );
});

test('Other pipelines and malformed summaries retain stored totals', () => {
  const other = withDisplayMetrics({ pipeline: 'teams', total_created: 4, total_updated: 5, total_skipped: 6 });
  const malformed = withDisplayMetrics({ pipeline: 'people', total_created: 9, total_updated: 8, total_skipped: 7, summary_json: '{' });

  assert.deepEqual(
    [other.display_created, other.display_updated, other.display_skipped, other.display_metric_label],
    [4, 5, 6, null]
  );
  assert.deepEqual(
    [malformed.display_created, malformed.display_updated, malformed.display_skipped, malformed.display_metric_label],
    [9, 8, 7, null]
  );
});
