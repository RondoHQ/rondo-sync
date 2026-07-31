'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const {
  setPlayerHistorySkip,
  clearPlayerHistorySkip,
  listPlayerHistorySkipped,
  getAllTrackedMembers
} = require('../lib/rondo-club-db');

// Minimal subset of the rondo_club_members schema that the quarantine
// helpers and getAllTrackedMembers touch. The full schema lives in initDb
// and runs 100+ ALTER statements at startup — we don't need any of that
// for these tests.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_members (
      knvb_id TEXT NOT NULL UNIQUE,
      rondo_club_id INTEGER,
      last_player_history_team_signature TEXT,
      player_history_skip_reason TEXT
    );
  `);
  return db;
}

function insertMember(db, knvbId, rondoClubId, signature = null, reason = null) {
  db.prepare(`
    INSERT INTO rondo_club_members
      (knvb_id, rondo_club_id, last_player_history_team_signature, player_history_skip_reason)
    VALUES (?, ?, ?, ?)
  `).run(knvbId, rondoClubId, signature, reason);
}

test('setPlayerHistorySkip writes the reason and rejects empty strings', () => {
  const db = makeDb();
  insertMember(db, 'PKWR41Q', 437);

  const changes = setPlayerHistorySkip(db, 'PKWR41Q', 'Sportlink memberships endpoint hangs');
  assert.equal(changes, 1);

  const row = db.prepare(`SELECT player_history_skip_reason FROM rondo_club_members WHERE knvb_id = ?`).get('PKWR41Q');
  assert.equal(row.player_history_skip_reason, 'Sportlink memberships endpoint hangs');

  assert.throws(() => setPlayerHistorySkip(db, 'PKWR41Q', ''), /non-empty reason/);
  assert.throws(() => setPlayerHistorySkip(db, 'PKWR41Q', '   '), /non-empty reason/);
  assert.throws(() => setPlayerHistorySkip(db, 'PKWR41Q', null), /non-empty reason/);

  db.close();
});

test('setPlayerHistorySkip returns 0 when knvb_id is not tracked', () => {
  const db = makeDb();
  const changes = setPlayerHistorySkip(db, 'NEVERSEEN', 'because');
  assert.equal(changes, 0);
  db.close();
});

test('clearPlayerHistorySkip lifts the quarantine; idempotent', () => {
  const db = makeDb();
  insertMember(db, 'PKWR41Q', 437, null, 'Sportlink bug');

  assert.equal(clearPlayerHistorySkip(db, 'PKWR41Q'), 1);
  const row = db.prepare(`SELECT player_history_skip_reason FROM rondo_club_members WHERE knvb_id = ?`).get('PKWR41Q');
  assert.equal(row.player_history_skip_reason, null);

  // Already cleared — second call is a no-op.
  assert.equal(clearPlayerHistorySkip(db, 'PKWR41Q'), 0);

  db.close();
});

test('listPlayerHistorySkipped returns only quarantined members, sorted', () => {
  const db = makeDb();
  insertMember(db, 'AAAA', 1);
  insertMember(db, 'PKWR41Q', 437, null, 'Sportlink bug 12345');
  insertMember(db, 'BBBB', 2);
  insertMember(db, 'ZZZZ', 99, null, 'temporarily broken');

  const skipped = listPlayerHistorySkipped(db);
  assert.deepEqual(skipped.map(m => m.knvb_id), ['PKWR41Q', 'ZZZZ']);
  assert.equal(skipped[0].player_history_skip_reason, 'Sportlink bug 12345');
  assert.equal(skipped[1].player_history_skip_reason, 'temporarily broken');

  db.close();
});

test('getAllTrackedMembers exposes player_history_skip_reason so the loop can read it', () => {
  const db = makeDb();
  insertMember(db, 'AAAA', 1);
  insertMember(db, 'PKWR41Q', 437, null, 'Sportlink bug');

  const members = getAllTrackedMembers(db);
  const quarantined = members.find(m => m.knvb_id === 'PKWR41Q');
  const normal = members.find(m => m.knvb_id === 'AAAA');

  // Critical: the player-history loop checks `member.player_history_skip_reason`
  // to decide whether to skip — this assertion is what guarantees that field
  // is actually populated from the SELECT.
  assert.equal(quarantined.player_history_skip_reason, 'Sportlink bug');
  assert.equal(normal.player_history_skip_reason, null);

  db.close();
});
