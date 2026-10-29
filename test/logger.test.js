'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loggerPath = require.resolve('../lib/logger');

async function runLogger(t, { disconnect = [], mode = 'normal' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rondo-logger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = `
    const { createSyncLogger } = require(process.argv[1]);
    const mode = process.argv[2];
    const before = [process.stdout.listenerCount('error'), process.stderr.listenerCount('error')];
    const logger = createSyncLogger({ logFile: 'sync.log', verbose: true });
    const other = createSyncLogger({ logFile: 'other.log' });
    process.send({ ready: true, added: [
      process.stdout.listenerCount('error') - before[0],
      process.stderr.listenerCount('error') - before[1]
    ] });
    process.once('message', async () => {
      if (mode === 'sync-epipe') {
        process.stdout.write = () => { throw Object.assign(new Error('closed'), { code: 'EPIPE' }); };
      }
      if (mode === 'other-error') {
        process.stdout.emit('error', Object.assign(new Error('terminal failure'), { code: 'EIO' }));
      }
      logger.log('first');
      logger.error('failure detail');
      await new Promise(resolve => setImmediate(resolve));
      logger.verbose('still running');
      logger.log('last');
      other.log('second logger still running');
      logger.close();
      other.close();
      process.disconnect();
    });
  `;
  const child = spawn(process.execPath, ['-e', script, loggerPath, mode], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const completion = once(child, 'close');
  const [ready] = await once(child, 'message');
  assert.deepEqual(ready.added, [1, 1], 'multiple loggers share terminal guards');
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  for (const streamName of disconnect) {
    const closed = once(child[streamName], 'close');
    child[streamName].destroy();
    await closed;
  }
  child.send('write');
  const [code, signal] = await completion;
  return { code, signal, stdout, stderr, dir };
}

function assertCompleteLog(result) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  const log = fs.readFileSync(path.join(result.dir, 'sync.log'), 'utf8');
  const messages = log.trim().split('\n').map(line => line.replace(/^\[[^\]]+\] /, ''));
  assert.deepEqual(messages, ['first', '[ERROR] failure detail', '[verbose] still running', 'last']);
  assert.match(fs.readFileSync(path.join(result.dir, 'other.log'), 'utf8'), /second logger still running/);
}

test('healthy stdout and stderr retain their output and the file contains every line', { timeout: 10000 }, async t => {
  const result = await runLogger(t);
  assertCompleteLog(result);
  assert.match(result.stdout, /first\n.*still running\nlast\n/s);
  assert.match(result.stderr, /\[ERROR\] failure detail/);
});

for (const disconnect of [['stdout'], ['stderr'], ['stdout', 'stderr']]) {
  test(`closed ${disconnect.join(' and ')} cannot abort logging or lose file entries`, { timeout: 10000 }, async t => {
    assertCompleteLog(await runLogger(t, { disconnect }));
  });
}

test('a synchronous EPIPE also leaves the complete file log', { timeout: 10000 }, async t => {
  assertCompleteLog(await runLogger(t, { mode: 'sync-epipe' }));
});

test('other terminal errors are not swallowed', { timeout: 10000 }, async t => {
  const result = await runLogger(t, { mode: 'other-error' });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /terminal failure/);
});
