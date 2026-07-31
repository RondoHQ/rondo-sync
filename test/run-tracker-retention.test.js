'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// lib/dashboard-db.js resolves data/dashboard.sqlite from process.cwd() ONCE, at
// require time. So the chdir has to happen before the requires below, and one
// temp dashboard has to serve the whole file — a per-test cwd would leave the
// cached path pointing at a deleted directory.
const ORIGINAL_CWD = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'run-retention-'));
fs.mkdirSync(path.join(TMP, 'data'));
process.chdir(TMP);

const { RunTracker } = require('../lib/run-tracker');
const { openDb } = require('../lib/dashboard-db');

process.on('exit', () => {
  process.chdir(ORIGINAL_CWD);
  fs.rmSync(TMP, { recursive: true, force: true });
});

const DAY = 86400000;
const db = openDb();

const insRun = db.prepare(
  'INSERT INTO runs (pipeline, started_at, finished_at, outcome) VALUES (?, ?, ?, ?)'
);
const insStep = db.prepare(
  'INSERT INTO run_steps (run_id, step_name, started_at) VALUES (?, ?, ?)'
);
const insErr = db.prepare(
  'INSERT INTO run_errors (run_id, step_name, error_message, created_at) VALUES (?, ?, ?, ?)'
);

function reset() {
  db.exec('DELETE FROM run_errors; DELETE FROM run_steps; DELETE FROM runs;');
}

// Each run gets a child step + error row so orphan sweeping is covered too.
function add(pipeline, daysAgo, outcome) {
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  const id = insRun.run(pipeline, at, at, outcome).lastInsertRowid;
  insStep.run(id, 'step', at);
  insErr.run(id, 'step', 'synthetic', at);
  return id;
}

function sweep() {
  const tracker = new RunTracker('test-harness');
  tracker._cleanup();
  return tracker;
}

const alive = (t, id) => !!t.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(id);
const latestOutcome = (t, pipeline) =>
  t.db
    .prepare('SELECT outcome FROM runs WHERE pipeline = ? ORDER BY started_at DESC LIMIT 1')
    .get(pipeline)?.outcome;

test('sparse pipelines survive the recent-window sweep', () => {
  reset();
  // The weekly functions-full run is far older than the 3-day window. If it is
  // swept, scripts/heal-sync.sh reads "no runs recorded yet" and can never heal
  // that pipeline again.
  const weekly = add('functions-full', 10, 'success');

  const tracker = sweep();
  assert.ok(alive(tracker, weekly), 'weekly run must outlive the 3-day window');
  assert.equal(latestOutcome(tracker, 'functions-full'), 'success');
  tracker.db.close();
});

test('a retained old failure never becomes "latest" over a newer success', () => {
  reset();
  // Failures are kept for 90 days. If the newer success were swept at 3 days,
  // the watchdog would read the stale failure as the latest run and re-heal an
  // episode that already recovered.
  add('teams', 20, 'failure');
  add('teams', 10, 'success');

  const tracker = sweep();
  assert.equal(latestOutcome(tracker, 'teams'), 'success', 'newest run must still be the success');
  tracker.db.close();
});

test('failure/partial outlive success, up to the 90-day tier', () => {
  reset();
  const recentFailure = add('discipline', 30, 'failure');
  const ancientFailure = add('discipline', 120, 'failure');
  const oldPartial = add('discipline', 60, 'partial');
  const oldSuccess = add('discipline', 30, 'success');
  // Push the above past the per-pipeline floor, which would otherwise keep
  // everything for a pipeline this sparse.
  for (let i = 0; i < 30; i++) add('discipline', i * 0.1, 'success');

  const tracker = sweep();
  assert.ok(alive(tracker, recentFailure), 'failure within 90d kept');
  assert.ok(alive(tracker, oldPartial), 'partial within 90d kept');
  assert.ok(!alive(tracker, ancientFailure), 'failure beyond 90d purged');
  assert.ok(!alive(tracker, oldSuccess), 'plain old success purged');
  tracker.db.close();
});

test('high-frequency pipelines stay bounded and leave no orphans', () => {
  reset();
  // reverse runs every 5 minutes; 7 days of it is what the sweep exists for.
  for (let d = 7; d >= 0; d--) {
    for (let n = 0; n < 288; n++) add('reverse', d - n / 288, 'success');
  }

  const tracker = sweep();
  const kept = tracker.db
    .prepare("SELECT COUNT(*) c FROM runs WHERE pipeline = 'reverse'").get().c;
  assert.ok(kept < 1300, `expected the 3-day window plus floor, got ${kept}`);
  assert.ok(kept > 800, `sweep must not eat the recent window, got ${kept}`);

  const orphanSteps = tracker.db
    .prepare('SELECT COUNT(*) c FROM run_steps WHERE run_id NOT IN (SELECT id FROM runs)').get().c;
  const orphanErrors = tracker.db
    .prepare('SELECT COUNT(*) c FROM run_errors WHERE run_id NOT IN (SELECT id FROM runs)').get().c;
  assert.equal(orphanSteps, 0, 'no orphaned run_steps');
  assert.equal(orphanErrors, 0, 'no orphaned run_errors');
  tracker.db.close();
});

test('running rows are never swept by age', () => {
  reset();
  // _markStaleRunning() owns reaping these; _cleanup must not race it.
  const stuck = add('nikki', 400, 'running');

  const tracker = sweep();
  assert.ok(alive(tracker, stuck), 'running rows are left for _markStaleRunning');
  tracker.db.close();
});
