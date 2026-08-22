'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  adoptParentMappingsForMembers,
  getMembersNeedingSync,
  getTrackedDeathStates,
  updateTrackedDeathState,
  upsertMembers,
  initDb
} = require('../lib/rondo-club-db');

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

function makeTransitionDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_members (
      knvb_id TEXT NOT NULL UNIQUE,
      rondo_club_id INTEGER,
      email TEXT,
      data_json TEXT NOT NULL
    );
    CREATE TABLE rondo_club_parents (
      email TEXT NOT NULL UNIQUE,
      rondo_club_id INTEGER,
      data_json TEXT NOT NULL
    );
  `);
  return db;
}

function insertTransitionMember(db, { knvbId, rondoClubId = null, email, firstName, lastName = '' }) {
  db.prepare(`
    INSERT INTO rondo_club_members (knvb_id, rondo_club_id, email, data_json)
    VALUES (?, ?, ?, ?)
  `).run(
    knvbId,
    rondoClubId,
    email,
    JSON.stringify({ fields: { first_name: firstName, last_name: lastName } })
  );
}

function insertTransitionParent(db, { email, rondoClubId, firstName, lastName = '', childKnvbIds = [] }) {
  db.prepare(`
    INSERT INTO rondo_club_parents (email, rondo_club_id, data_json)
    VALUES (?, ?, ?)
  `).run(
    email,
    rondoClubId,
    JSON.stringify({
      data: { fields: { first_name: firstName, last_name: lastName } },
      childKnvbIds
    })
  );
}

test('death-date tracking changes only after a verified reconciliation', () => {
  const db = new Database(':memory:');
  initDb(db);

  upsertMembers(db, [{
    knvb_id: 'PEEX433',
    email: 'history@example.test',
    data: { fields: { datum_overlijden: '2026-08-20' } }
  }]);
  db.prepare('UPDATE rondo_club_members SET rondo_club_id = 4685 WHERE knvb_id = ?').run('PEEX433');

  assert.equal(getTrackedDeathStates(db)[0].date_of_passing, null);
  updateTrackedDeathState(db, 'PEEX433', '2026-08-20');

  upsertMembers(db, [{
    knvb_id: 'PEEX433',
    email: 'history@example.test',
    data: { fields: { datum_overlijden: '2026-08-20' } }
  }]);
  assert.equal(getTrackedDeathStates(db)[0].date_of_passing, '2026-08-20');

  db.close();
});

test('adopts an existing standalone parent post when that parent becomes a member', () => {
  const db = makeTransitionDb();
  insertTransitionMember(db, {
    knvbId: 'SZGN36W',
    rondoClubId: 769,
    email: 'linda.atema88@example.test',
    firstName: 'Job',
    lastName: 'Atema'
  });
  insertTransitionMember(db, {
    knvbId: 'NEW-LINDA',
    email: 'linda.atema88@example.test',
    firstName: 'Linda',
    lastName: 'Atema'
  });
  insertTransitionParent(db, {
    email: 'linda.atema88@example.test',
    rondoClubId: 1232,
    firstName: 'Linda Atema',
    childKnvbIds: ['SZGN36W']
  });

  const result = adoptParentMappingsForMembers(db, ['NEW-LINDA']);

  assert.deepEqual(result, {
    adopted: [{
      knvb_id: 'NEW-LINDA',
      email: 'linda.atema88@example.test',
      rondo_club_id: 1232
    }],
    ambiguous: []
  });
  assert.equal(
    db.prepare('SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?').get('NEW-LINDA').rondo_club_id,
    1232
  );
  db.close();
});

test('does not adopt a parent post for a known child sharing the family email', () => {
  const db = makeTransitionDb();
  insertTransitionMember(db, {
    knvbId: 'CHILD1',
    email: 'family@example.test',
    firstName: 'Alex',
    lastName: 'Jansen'
  });
  insertTransitionParent(db, {
    email: 'family@example.test',
    rondoClubId: 9001,
    firstName: 'Alex Jansen',
    childKnvbIds: ['CHILD1']
  });

  const result = adoptParentMappingsForMembers(db, ['CHILD1']);

  assert.deepEqual(result, { adopted: [], ambiguous: [] });
  assert.equal(
    db.prepare('SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?').get('CHILD1').rondo_club_id,
    null
  );
  db.close();
});

test('does not adopt one parent post for two indistinguishable new members', () => {
  const db = makeTransitionDb();
  for (const knvbId of ['NEW1', 'NEW2']) {
    insertTransitionMember(db, {
      knvbId,
      email: 'same@example.test',
      firstName: 'Sam',
      lastName: 'Jansen'
    });
  }
  insertTransitionParent(db, {
    email: 'same@example.test',
    rondoClubId: 9001,
    firstName: 'Sam Jansen',
    childKnvbIds: ['OTHER-CHILD']
  });

  const result = adoptParentMappingsForMembers(db, ['NEW1', 'NEW2']);

  assert.equal(result.adopted.length, 0);
  assert.equal(result.ambiguous.length, 2);
  assert.deepEqual(
    db.prepare('SELECT rondo_club_id FROM rondo_club_members ORDER BY knvb_id').all(),
    [{ rondo_club_id: null }, { rondo_club_id: null }]
  );
  db.close();
});

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
      ('Remarks1', 'custom-note', 'acf', 'string', '2026-07-31T00:00:00.000Z'),
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

test('initDb migrates cached ACF envelopes without changing sync hashes', () => {
  const db = new Database(':memory:');
  initDb(db);
  db.prepare(`
    INSERT INTO rondo_club_members
      (knvb_id, data_json, source_hash, last_seen_at, last_synced_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'TEST123',
    JSON.stringify({
      status: 'publish',
      acf: {
        'knvb-id': 'TEST123',
        'datum-vog': '2026-01-02',
        birth_year: 1990,
        addresses: [{ 'address-label': 'Home', postal_code: '1234 AB' }]
      },
      meta: { team: 'Test 1' }
    }),
    'source-before',
    '2026-08-01T00:00:00.000Z',
    'synced-before',
    '2026-08-01T00:00:00.000Z'
  );
  db.prepare(`
    INSERT INTO rondo_club_parents
      (email, data_json, source_hash, last_seen_at, last_synced_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    'parent@example.test',
    JSON.stringify({
      data: { status: 'publish', acf: { first_name: 'Test', 'last-name': 'Parent' } },
      childKnvbIds: ['TEST123']
    }),
    'parent-source-before',
    '2026-08-01T00:00:00.000Z',
    'parent-synced-before',
    '2026-08-01T00:00:00.000Z'
  );

  initDb(db);

  const member = db.prepare('SELECT data_json, source_hash, last_synced_hash FROM rondo_club_members WHERE knvb_id = ?').get('TEST123');
  assert.deepEqual(JSON.parse(member.data_json), {
    fields: {
      addresses: [{ address_label: 'Home', postal_code: '1234 AB' }],
      datum_vog: '2026-01-02',
      knvb_id: 'TEST123'
    },
    meta: { team: 'Test 1' },
    status: 'publish'
  });
  assert.equal(member.source_hash, 'source-before');
  assert.equal(member.last_synced_hash, 'synced-before');

  const parent = db.prepare('SELECT data_json, source_hash, last_synced_hash FROM rondo_club_parents WHERE email = ?').get('parent@example.test');
  assert.deepEqual(JSON.parse(parent.data_json), {
    childKnvbIds: ['TEST123'],
    data: { fields: { first_name: 'Test', last_name: 'Parent' }, status: 'publish' }
  });
  assert.equal(parent.source_hash, 'parent-source-before');
  assert.equal(parent.last_synced_hash, 'parent-synced-before');

  initDb(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rondo_club_members WHERE data_json LIKE '%\"acf\"%'").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM rondo_club_parents WHERE data_json LIKE '%\"acf\"%'").get().count, 0);
  db.close();
});
