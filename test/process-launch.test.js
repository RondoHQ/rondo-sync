const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { waitForEarlyExit, readLaunchFailure } = require('../lib/process-launch');

test('waitForEarlyExit reports an immediate non-zero exit', async () => {
  const child = new EventEmitter();
  const resultPromise = waitForEarlyExit(child, 100);
  child.emit('exit', 1, null);

  assert.deepEqual(await resultPromise, { code: 1, signal: null });
});

test('waitForEarlyExit leaves a running child alone after the observation window', async () => {
  const child = new EventEmitter();
  assert.equal(await waitForEarlyExit(child, 5), null);
});

test('readLaunchFailure returns the final two non-empty log lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondo-launch-'));
  const logPath = path.join(dir, 'launch.log');
  fs.writeFileSync(logPath, 'Starting\n\nAlready running\nLikely hung\n');

  assert.equal(readLaunchFailure(logPath, 'fallback'), 'Already running Likely hung');
  fs.rmSync(dir, { recursive: true, force: true });
});
