'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  getUnsyncedChanges,
  initDb,
  logChangeDetection
} = require('../lib/rondo-club-db');
const { reconcilePendingChanges } = require('../lib/reverse-sync-sportlink');

function logPendingChange(db, fieldName, newValue) {
  logChangeDetection(db, {
    knvb_id: 'TEST123',
    field_name: fieldName,
    old_value: null,
    new_value: newValue,
    rondo_club_modified_gmt: '2026-08-23T11:55:00',
    detection_run_id: 'test-run'
  });
}

test('a corrected contact slot supersedes its stale pending value', () => {
  const db = new Database(':memory:');
  initDb(db);

  logPendingChange(db, 'telephone_2', '+31612345678');
  logPendingChange(db, 'mobile_1', '+31612345678');
  logPendingChange(db, 'email_2', 'current@example.test');

  const pending = getUnsyncedChanges(db);
  const superseded = reconcilePendingChanges(db, pending, {
    fields: {
      telephone_2: '',
      mobile_1: '+31612345678',
      email_2: 'current@example.test'
    }
  });

  assert.equal(superseded, 1);
  assert.deepEqual(
    getUnsyncedChanges(db).map(change => change.field_name).sort(),
    ['email_2', 'mobile_1']
  );

  const stale = db.prepare(`
    SELECT synced_at, superseded_at
    FROM rondo_club_change_detections
    WHERE field_name = 'telephone_2'
  `).get();
  assert.equal(stale.synced_at, null);
  assert.ok(stale.superseded_at);

  db.close();
});
