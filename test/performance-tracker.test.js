const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const original = process.cwd();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rondo-performance-test-'));
fs.mkdirSync(path.join(directory, 'data'));
process.chdir(directory);
const monitoring = require('../lib/error-monitoring');
const { RunTracker } = require('../lib/run-tracker');
process.on('exit', () => { process.chdir(original); fs.rmSync(directory, { recursive: true, force: true }); });

test('real tracker emits one step and one run with shared trace, timing and aggregate counts', () => {
  const events = [];
  const record = monitoring.recordPerformance;
  monitoring.recordPerformance = details => events.push(details);
  try {
    const tracker = new RunTracker('people');
    assert.ok(tracker.startRun());
    const step = tracker.startStep('sportlink-download');
    tracker.endStep(step, { created: 2, detail: { member: 'PRIVATE' } });
    tracker.endRun(true, { member: 'PRIVATE' });
    assert.equal(events.length, 2);
    assert.equal(events[0].step, 'sportlink-download');
    assert.equal(events[1].counts.created, 2);
    assert.equal(events[0].traceId, events[1].traceId);
    assert.ok(new Date(events[0].finishedAt) >= new Date(events[0].startedAt));
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
  } finally { monitoring.recordPerformance = record; }
});
