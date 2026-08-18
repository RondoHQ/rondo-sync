'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  initDb,
  upsertMemberFunctions,
  getMemberFunctions,
  upsertMemberCommittees,
  getMemberCommittees
} = require('../lib/rondo-club-db');
const { storeMemberFunctionSnapshots } = require('../steps/download-functions-from-sportlink');
const {
  buildCommissieSyncQueue,
  findCommissieWorkHistoryIndex,
  syncCommissieWorkHistoryForMember
} = require('../steps/submit-rondo-club-commissie-work-history');

function makeSnapshotDb() {
  const db = new Database(':memory:');
  initDb(db);
  return db;
}

function functionRow(knvbId, description) {
  return {
    knvb_id: knvbId,
    function_description: description,
    relation_start: '2025-07-01',
    relation_end: null,
    is_active: true
  };
}

function committeeRow(knvbId, name, role) {
  return {
    knvb_id: knvbId,
    committee_name: name,
    sportlink_committee_id: null,
    role_name: role,
    relation_start: '2025-07-01',
    relation_end: null,
    is_active: true
  };
}

test('recent function responses replace only successful member snapshots', () => {
  const db = makeSnapshotDb();
  upsertMemberFunctions(db, [
    functionRow('MEMBER-A', 'Jeugdbegeleid(st)er'),
    functionRow('MEMBER-B', 'Secretaris')
  ]);
  upsertMemberCommittees(db, [
    committeeRow('MEMBER-A', 'Jeugdcommissie', 'Lid'),
    committeeRow('MEMBER-B', 'Bestuur', 'Lid')
  ]);

  storeMemberFunctionSnapshots(db, {
    recentOnly: true,
    processedMemberCount: 2,
    functions: [functionRow('MEMBER-A', 'Wedstrijdsecretaris')],
    committees: [],
    successfulFunctionMembers: new Set(['MEMBER-A']),
    successfulCommitteeMembers: new Set(['MEMBER-A'])
  });

  assert.deepEqual(
    getMemberFunctions(db, 'MEMBER-A').map(row => row.function_description),
    ['Wedstrijdsecretaris'],
    'a disappeared function is removed when the endpoint returned a complete snapshot'
  );
  assert.deepEqual(getMemberCommittees(db, 'MEMBER-A'), [], 'a successful empty response clears the old snapshot');
  assert.deepEqual(
    getMemberFunctions(db, 'MEMBER-B').map(row => row.function_description),
    ['Secretaris'],
    'a failed function response preserves the previous snapshot'
  );
  assert.deepEqual(
    getMemberCommittees(db, 'MEMBER-B').map(row => row.committee_name),
    ['Bestuur'],
    'a failed committee response preserves the previous snapshot'
  );
  db.close();
});

test('a fully successful full run removes rows for members outside the active snapshot', () => {
  const db = makeSnapshotDb();
  upsertMemberFunctions(db, [functionRow('FORMER-MEMBER', 'Jeugdbegeleid(st)er')]);

  storeMemberFunctionSnapshots(db, {
    recentOnly: false,
    processedMemberCount: 1,
    functions: [functionRow('ACTIVE-MEMBER', 'Secretaris')],
    committees: [],
    successfulFunctionMembers: new Set(['ACTIVE-MEMBER']),
    successfulCommitteeMembers: new Set(['ACTIVE-MEMBER'])
  });

  assert.deepEqual(getMemberFunctions(db, 'FORMER-MEMBER'), []);
  assert.deepEqual(
    getMemberFunctions(db, 'ACTIVE-MEMBER').map(row => row.function_description),
    ['Secretaris']
  );
  db.close();
});

test('work-history queue includes tracked roles that disappeared from Sportlink', () => {
  const current = new Map([
    ['MEMBER-A', [{ commissie_name: 'Verenigingsbreed', role_name: 'Kaderlid Algemeen' }]],
    ['MEMBER-C', [{ commissie_name: 'Bestuur', role_name: 'Lid' }]]
  ]);
  const allTracked = [
    { knvb_id: 'MEMBER-A', rondo_club_id: 241, commissie_name: 'Verenigingsbreed', role_name: 'Jeugdbegeleid(st)er', rondo_club_work_history_id: 3 },
    { knvb_id: 'MEMBER-A', rondo_club_id: 241, commissie_name: 'Verenigingsbreed', role_name: 'Kaderlid Algemeen', rondo_club_work_history_id: 4 },
    { knvb_id: 'MEMBER-B', rondo_club_id: 846, commissie_name: 'Verenigingsbreed', role_name: 'Handmatig', rondo_club_work_history_id: null },
    { knvb_id: 'MEMBER-C', rondo_club_id: 100, commissie_name: 'Bestuur', role_name: 'Lid', rondo_club_work_history_id: 1 }
  ];
  const needsSync = [{ knvb_id: 'MEMBER-D', rondo_club_id: 200 }];

  assert.deepEqual(buildCommissieSyncQueue(needsSync, allTracked, current), [
    { knvb_id: 'MEMBER-D', rondo_club_id: 200 },
    { knvb_id: 'MEMBER-A', rondo_club_id: 241 }
  ]);
});

test('stale repeater index is resolved by commissie and role', () => {
  const rows = [
    { team_id: 999, job_title: 'Handmatig', is_current: true },
    { team_id: 2662, job_title: 'Jeugdbegeleid(st)er', is_current: true }
  ];

  assert.equal(findCommissieWorkHistoryIndex(rows, 0, 2662, 'Jeugdbegeleid(st)er'), 1);
});

test('failed Rondo update keeps removal tracking for retry and preserves manual rows', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_commissie_work_history (
      knvb_id TEXT NOT NULL,
      commissie_name TEXT NOT NULL,
      role_name TEXT,
      rondo_club_work_history_id INTEGER,
      is_backfill INTEGER DEFAULT 0,
      source_hash TEXT NOT NULL,
      last_synced_hash TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(knvb_id, commissie_name, role_name)
    );
    INSERT INTO rondo_club_commissie_work_history (
      knvb_id, commissie_name, role_name, rondo_club_work_history_id,
      source_hash, last_synced_hash, created_at
    ) VALUES (
      'MEMBER-A', 'Verenigingsbreed', 'Jeugdbegeleid(st)er', 0,
      'source', 'source', '2026-08-01T00:00:00.000Z'
    );
  `);

  const remoteFields = {
    first_name: 'Paul',
    last_name: 'van der Vaart',
    work_history: [
      { team_id: 999, job_title: 'Handmatig', is_current: true, end_date: null },
      { team_id: 2662, job_title: 'Jeugdbegeleid(st)er', is_current: true, end_date: null }
    ]
  };
  let failPut = true;
  const putPayloads = [];
  const request = async (endpoint, method, payload) => {
    if (method === 'GET') {
      return { body: { fields: remoteFields } };
    }
    putPayloads.push(payload);
    if (failPut) {
      throw new Error('temporary Rondo failure');
    }
    return { body: { id: 241 } };
  };
  const args = [
    { knvb_id: 'MEMBER-A', rondo_club_id: 241 },
    [],
    db,
    new Map([['Verenigingsbreed', 2662]]),
    { request }
  ];

  await assert.rejects(syncCommissieWorkHistoryForMember(...args), /temporary Rondo failure/);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM rondo_club_commissie_work_history').get().count,
    1,
    'tracking remains pending after a failed remote update'
  );

  failPut = false;
  const result = await syncCommissieWorkHistoryForMember(...args);
  assert.deepEqual(result, { action: 'updated', added: 0, ended: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_commissie_work_history').get().count, 0);

  const writtenRows = putPayloads.at(-1).fields.work_history;
  assert.deepEqual(writtenRows[0], remoteFields.work_history[0], 'manual row is unchanged');
  assert.equal(writtenRows[1].is_current, false);
  assert.match(writtenRows[1].end_date, /^\d{4}-\d{2}-\d{2}$/);

  const rerun = await syncCommissieWorkHistoryForMember(...args);
  assert.deepEqual(rerun, { action: 'unchanged', added: 0, ended: 0 });
  assert.equal(putPayloads.length, 2, 'the successful removal is idempotent');
  db.close();
});
