'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { getMembersNeedingSync, initDb } = require('../lib/rondo-club-db');

// Build a minimal rondo_club_members table — just the columns the query reads.
// We don't run the full schema migration here because it includes 50+ columns
// for tracked-field timestamps that getMembersNeedingSync doesn't touch.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_members (
      knvb_id TEXT NOT NULL UNIQUE,
      rondo_club_id INTEGER,
      email TEXT,
      data_json TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      last_synced_hash TEXT
    );
  `);
  return db;
}

function insert(db, row) {
  db.prepare(`
    INSERT INTO rondo_club_members (knvb_id, rondo_club_id, email, data_json, source_hash, last_synced_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.knvb_id, row.rondo_club_id, row.email, row.data_json, row.source_hash, row.last_synced_hash);
}

// Regression: on 2026-05-28 the People sync wasted 2h12m and produced 1,477
// rest_invalid_type errors because getMembersNeedingSync returned every former
// member (data_json='{}') whose last_synced_hash never matched source_hash
// (markFormerMembers writes the sentinel without updating the synced hash).
// syncPerson then PUT a payload built from the empty mirror, and any stale
// junk in older blobs (e.g. _nikki_YYYY_saldo: "") tripped WP REST validation.
test('getMembersNeedingSync excludes rows with empty data_json mirror', () => {
  const db = makeDb();

  insert(db, {
    knvb_id: 'ACTIVE_NEW',
    rondo_club_id: 100,
    email: 'a@example.com',
    data_json: '{"fields":{"first_name":"A"}}',
    source_hash: 'h1',
    last_synced_hash: null  // never synced -> needs sync
  });
  insert(db, {
    knvb_id: 'ACTIVE_CHANGED',
    rondo_club_id: 101,
    email: 'b@example.com',
    data_json: '{"fields":{"first_name":"B"}}',
    source_hash: 'h2',
    last_synced_hash: 'h2-old'  // hash mismatch -> needs sync
  });
  insert(db, {
    knvb_id: 'ACTIVE_UNCHANGED',
    rondo_club_id: 102,
    email: 'c@example.com',
    data_json: '{"fields":{"first_name":"C"}}',
    source_hash: 'h3',
    last_synced_hash: 'h3'  // matches -> skip
  });
  insert(db, {
    knvb_id: 'FORMER_EMPTY_MIRROR',
    rondo_club_id: 103,
    email: 'd@example.com',
    data_json: '{}',  // sentinel from markFormerMembers
    source_hash: 'h4',
    last_synced_hash: null  // hash mismatch but no payload to PUT
  });

  const needsSync = getMembersNeedingSync(db);
  const ids = needsSync.map(m => m.knvb_id).sort();

  assert.deepEqual(ids, ['ACTIVE_CHANGED', 'ACTIVE_NEW']);
  // Explicitly: the former-member row must not appear.
  assert.ok(!ids.includes('FORMER_EMPTY_MIRROR'));

  db.close();
});

test('getMembersNeedingSync force=true also excludes empty-mirror rows', () => {
  const db = makeDb();

  insert(db, {
    knvb_id: 'ACTIVE',
    rondo_club_id: 100,
    email: 'a@example.com',
    data_json: '{"fields":{"first_name":"A"}}',
    source_hash: 'h1',
    last_synced_hash: 'h1'  // would normally be skipped, but force=true
  });
  insert(db, {
    knvb_id: 'FORMER',
    rondo_club_id: 200,
    email: null,
    data_json: '{}',
    source_hash: 'h2',
    last_synced_hash: null
  });

  const needsSync = getMembersNeedingSync(db, true);
  assert.deepEqual(needsSync.map(m => m.knvb_id), ['ACTIVE']);

  db.close();
});

test('initDb migrates legacy free-field scopes to fields without losing mappings', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE free_field_mappings (
      source_field TEXT PRIMARY KEY,
      target_field TEXT,
      target_scope TEXT NOT NULL DEFAULT 'acf',
      value_type TEXT NOT NULL DEFAULT 'string',
      updated_at TEXT NOT NULL,
      CHECK (target_scope IN ('acf','meta'))
    );
    INSERT INTO free_field_mappings
      (source_field, target_field, target_scope, value_type, updated_at)
    VALUES
      ('Remarks1', 'custom_note', 'acf', 'string', '2026-07-31T00:00:00.000Z'),
      ('Remarks2', 'legacy_meta', 'meta', 'number', '2026-07-31T00:00:00.000Z');
  `);

  initDb(db);

  const mappings = db.prepare(`
    SELECT source_field, target_field, target_scope, value_type
    FROM free_field_mappings
    WHERE source_field IN ('Remarks1', 'Remarks2')
    ORDER BY source_field
  `).all();
  assert.deepEqual(mappings, [
    {
      source_field: 'Remarks1',
      target_field: 'custom_note',
      target_scope: 'fields',
      value_type: 'string'
    },
    {
      source_field: 'Remarks2',
      target_field: 'legacy_meta',
      target_scope: 'meta',
      value_type: 'number'
    }
  ]);

  const tableSql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'free_field_mappings'"
  ).get().sql;
  assert.match(tableSql, /CHECK \(target_scope IN \('fields','meta'\)\)/);
  assert.doesNotMatch(tableSql, /'acf'/);

  db.close();
});
