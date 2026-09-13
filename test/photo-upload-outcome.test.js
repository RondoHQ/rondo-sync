const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { photoEvents } = require('../lib/dashboard-metrics');
const { logPhotoEvent } = require('../lib/photo-sync-log');

test('HTTP 200 protected-photo skips do not count or log as changed; actual saves do', async () => {
  const originalLoad = Module._load;
  let responseBody = { success: true, skipped: true, reason: 'manual_photo_protected' };
  let statusCode = 200;
  let state = 'downloaded';
  const lines = [];
  const logger = { log: line => lines.push(line), error: line => lines.push(line), verbose: () => {}, section: () => {} };
  const member = { knvb_id: 'TEST001', rondo_club_id: 123 };
  Module._load = function(request, parent, isMain) {
    if (parent?.filename.endsWith('upload-photos-to-rondo-club.js')) {
      if (request === '../lib/rondo-club-db') return {
        openDb: () => ({ close() {} }),
        getMembersByPhotoState: (_db, desired) => state === desired ? [member] : [],
        updatePhotoState: (_db, _id, next) => { state = next; },
        clearPhotoState: () => { state = 'no_photo'; }
      };
      if (request === '../lib/utils') return { readEnv: key => key === 'RONDO_URL' ? 'https://example.test' : 'test' };
      if (request === 'fs/promises') return { access: async () => {}, unlink: async () => {} };
      if (request === 'fs') return { createReadStream: () => ({}) };
      if (request === 'form-data') return class { append() {} getHeaders() { return {}; } pipe(req) { req.end(); } };
      if (request === 'https') return {
        request: (_options, callback) => {
          const req = new EventEmitter();
          req.end = () => queueMicrotask(() => {
            const response = new EventEmitter();
            response.statusCode = statusCode;
            callback(response);
            response.emit('data', typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
            response.emit('end');
          });
          return req;
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };
  const modulePath = require.resolve('../steps/upload-photos-to-rondo-club');
  delete require.cache[modulePath];
  try {
    const { runPhotoSync } = require(modulePath);
    const skipped = await runPhotoSync({ logger });
    assert.equal(skipped.upload.synced, 0);
    assert.equal(skipped.upload.skipped, 1);
    assert.equal(skipped.success, true);
    assert.equal(state, 'synced', 'a confirmed skip is processed and will not retry unchanged data');
    assert.equal(skipped.results[0].status, 'skipped');
    assert.match(lines.join('\n'), /Bron: Sportlink\/voetbal.nl.*Handmatige Rondo-foto behouden/);
    assert.ok(!lines.some(line => line.startsWith('Foto gewijzigd')));

    state = 'downloaded';
    responseBody = { success: true, attachment_id: 456 };
    const changed = await runPhotoSync({ logger });
    assert.equal(changed.upload.synced, 1);
    assert.equal(changed.upload.skipped, 0);
    assert.deepEqual(photoEvents(JSON.stringify({ photos: changed })), changed.results);
    assert.equal(changed.results[0].source, 'sportlink');
    assert.equal(changed.results[0].destination, 'rondo');
    assert.match(lines.at(-1), /No photos pending deletion/);
    assert.ok(lines.some(line => line.startsWith('Foto gewijzigd')));

    for (const body of ['invalid json', {}, { success: false }, { success: true }]) {
      responseBody = body;
      state = 'downloaded';
      const failed = await runPhotoSync({ logger });
      assert.equal(failed.upload.synced, 0);
      assert.equal(failed.success, false);
      assert.equal(failed.results[0].status, 'failed');
      assert.equal(state, 'downloaded', 'unconfirmed saves are not marked as processed');
    }

    state = 'pending_delete';
    statusCode = 500;
    assert.equal((await runPhotoSync({ logger })).delete.deleted, 0);
    assert.equal(state, 'pending_delete');
    statusCode = 404;
    const absent = await runPhotoSync({ logger });
    assert.equal(absent.delete.deleted, 0);
    assert.equal(absent.delete.skipped, 1);
    assert.equal(absent.results[0].status, 'skipped');
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
});

test('Rondo-origin changes keep their origin when delivered to Sportlink', () => {
  const lines = [];
  logPhotoEvent({ log: line => lines.push(line) }, { personId: 123, knvbId: 'TEST001', source: 'rondo', destination: 'sportlink', status: 'changed' });
  assert.match(lines[0], /Bron: Rondo \| Naar: Sportlink\/voetbal.nl/);
  assert.deepEqual(photoEvents('{}'), []);
  assert.deepEqual(photoEvents('invalid'), []);
});
