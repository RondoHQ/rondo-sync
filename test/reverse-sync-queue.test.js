'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  getUnsyncedChanges,
  initDb,
  logChangeDetection,
  markChangesActionRequired
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

  logPendingChange(db, 'telephone_1', '+31241234567');
  logPendingChange(db, 'mobile_1', '+31612345678');
  logPendingChange(db, 'email_2', 'current@example.test');

  const pending = getUnsyncedChanges(db);
  const superseded = reconcilePendingChanges(db, pending, {
    fields: {
      telephone_1: '',
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
    WHERE field_name = 'telephone_1'
  `).get();
  assert.equal(stale.synced_at, null);
  assert.ok(stale.superseded_at);

  db.close();
});

test('an explicit empty value remains a writable pending change', () => {
  const db = new Database(':memory:');
  initDb(db);

  logPendingChange(db, 'mobile_1', null);

  assert.deepEqual(
    getUnsyncedChanges(db).map(change => ({ field: change.field_name, value: change.new_value })),
    [{ field: 'mobile_1', value: null }]
  );

  db.close();
});

test('an action-required change leaves the five-minute queue and keeps its audit state', () => {
  const db = new Database(':memory:');
  initDb(db);
  logPendingChange(db, 'mobile_1', '+31612345678');

  const result = markChangesActionRequired(
    db,
    'TEST123',
    ['mobile_1'],
    'Sportlink vraagt om handmatig herstel.'
  );

  assert.deepEqual(result, { updated: 1, newlyRequired: 1 });
  assert.deepEqual(getUnsyncedChanges(db), []);
  const row = db.prepare(`
    SELECT synced_at, superseded_at, next_attempt_at, last_error, action_required_at
    FROM rondo_club_change_detections
    WHERE knvb_id = 'TEST123' AND field_name = 'mobile_1'
  `).get();
  assert.equal(row.synced_at, null);
  assert.equal(row.superseded_at, null);
  assert.ok(row.next_attempt_at);
  assert.equal(row.last_error, 'Sportlink vraagt om handmatig herstel.');
  assert.ok(row.action_required_at);

  db.close();
});
