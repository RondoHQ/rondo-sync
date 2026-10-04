'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getPlayerHistoryMembers, getAllTrackedMembers } = require('../lib/rondo-club-db');

test('player history excludes obsolete identities while preserving their recovery mappings', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE rondo_club_members (
      knvb_id TEXT, rondo_club_id INTEGER, data_json TEXT,
      retired_into_knvb_id TEXT, last_player_history_team_signature TEXT,
      player_history_skip_reason TEXT
    )`);
    const insert = db.prepare('INSERT INTO rondo_club_members VALUES (?, ?, ?, ?, ?, ?)');
    insert.run('CURRENT', 608, '{"fields":{"knvb_id":"CURRENT"}}', null, 'v2:abc', null);
    insert.run('OLD_ALIAS', 608, '{}', null, null, null);
    insert.run('MISSING', 12585, '{}', null, null, null);
    insert.run('RETIRED', 12586, '{"fields":{"knvb_id":"RETIRED"}}', 'CURRENT', null, null);
    insert.run('QUARANTINED', 437, '{"fields":{}}', null, null, 'Source endpoint hangs');
    insert.run('UNLINKED', null, '{"fields":{}}', null, null, null);

    const members = getPlayerHistoryMembers(db);
    assert.deepEqual(members.map(member => member.knvb_id), ['CURRENT', 'QUARANTINED']);
    assert.equal(members[0].last_player_history_team_signature, 'v2:abc');
    assert.equal(members[1].player_history_skip_reason, 'Source endpoint hangs');
    assert.equal(getAllTrackedMembers(db).length, 5, 'other consumers retain the full mapping');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_members').get().count, 6);

    db.prepare("UPDATE rondo_club_members SET data_json = ? WHERE knvb_id = 'MISSING'")
      .run('{"fields":{"knvb_id":"MISSING"}}');
    assert.ok(getPlayerHistoryMembers(db).some(member => member.knvb_id === 'MISSING'),
      'a member who reappears becomes eligible again');
  } finally { db.close(); }
});
