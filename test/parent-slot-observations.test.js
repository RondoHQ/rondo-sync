'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getParentSyncMembers, getAllTrackedMembers } = require('../lib/rondo-club-db');
const { prepareParentSlotObservations, submitParentSlotObservations } = require('../lib/parent-slot-observations');

const source = (id = 'CHILD1') => ({ PublicPersonId: id, NameParent1: 'Noor van Dijk', EmailAddressParent1: 'noor@example.org', NameParent2: null, EmailAddressParent2: '' });
const observedAt = '2026-09-13T09:46:00.783Z';

test('reimported retired identities cannot send slots to deleted or surviving people', async () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE rondo_club_members (
      knvb_id TEXT, rondo_club_id INTEGER, retired_into_knvb_id TEXT,
      last_player_history_team_signature TEXT, player_history_skip_reason TEXT
    )`);
    const insert = db.prepare('INSERT INTO rondo_club_members (knvb_id, rondo_club_id, retired_into_knvb_id) VALUES (?, ?, ?)');
    insert.run('CURRENT', 20, null);
    insert.run('RETIRED_DELETED', 10, 'CURRENT');
    insert.run('RETIRED_SHARED', 20, 'CURRENT');
    insert.run('UNLINKED', null, null);
    const observations = prepareParentSlotObservations([
      source('RETIRED_DELETED'), source('RETIRED_SHARED'), source('CURRENT'), source('UNLINKED')
    ], observedAt);
    const ids = new Map(getParentSyncMembers(db).map(member => [member.knvb_id, member.rondo_club_id]));
    const sent = [];
    const result = await submitParentSlotObservations(observations, ids, {
      rondoClubRequest: async (path, method, payload) => {
        sent.push(...payload.observations);
        return { body: { results: payload.observations.map(item => ({ person_id: item.person_id, observed: true, matched: 1 })) } };
      }
    });
    assert.deepEqual(sent.map(item => [item.knvb_id, item.person_id]), [['CURRENT', 20]]);
    assert.deepEqual(result, { observed: 1, matched: 1, skipped: 3, errors: [] });
    assert.equal(getAllTrackedMembers(db).length, 3, 'retired recovery mappings remain available');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM rondo_club_members WHERE retired_into_knvb_id IS NOT NULL').get().count, 2);
  } finally { db.close(); }
});

test('preserves source slot order, explicit emptiness, and the actual snapshot date', () => {
  const [item] = prepareParentSlotObservations([source()], observedAt);
  assert.equal(item.observed_at, observedAt);
  assert.deepEqual(item.slots, [{ slot: 1, email: 'noor@example.org', name: 'Noor van Dijk' }, { slot: 2, email: '', name: '' }]);
});

test('partial, malformed, undated and duplicate member sources cannot clear labels', () => {
  const partial = source();
  delete partial.NameParent2;
  assert.deepEqual(prepareParentSlotObservations([partial], observedAt), []);
  assert.deepEqual(prepareParentSlotObservations([{ ...source(), NameParent2: {} }], observedAt), []);
  assert.deepEqual(prepareParentSlotObservations([source()], null), []);
  assert.deepEqual(prepareParentSlotObservations([source(), source()], observedAt), []);
});

test('imports unchanged mapped members in bounded batches through the observation endpoint only', async () => {
  const members = Array.from({ length: 102 }, (_, i) => source(`CHILD${i}`));
  const observations = prepareParentSlotObservations(members, observedAt);
  const ids = new Map(members.slice(0, 101).map((member, i) => [member.PublicPersonId, i + 10]));
  const calls = [];
  const result = await submitParentSlotObservations(observations, ids, {
    rondoClubRequest: async (path, method, payload) => {
      calls.push(payload.observations.length);
      assert.equal(path, 'rondo/v1/people/parent-slot-observations');
      assert.equal(method, 'POST');
      assert.equal(payload.observations[0].observed_at, observedAt);
      return { body: { results: payload.observations.map(item => ({ person_id: item.person_id, observed: true, matched: 1 })) } };
    }
  });
  assert.deepEqual(calls, [100, 1]);
  assert.deepEqual(result, { observed: 101, matched: 101, skipped: 1, errors: [] });
});

test('reports identity failures and preserves stale observations as skipped', async () => {
  const result = await submitParentSlotObservations(prepareParentSlotObservations([source('A'), source('B')], observedAt), new Map([['A', 10], ['B', 11]]), {
    rondoClubRequest: async () => ({ body: { results: [{ person_id: 10, error: 'identity_mismatch' }, { person_id: 11, observed: false, reason: 'stale' }] } })
  });
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.errors, [{ person_id: 10, message: 'identity_mismatch' }]);
});

test('does not treat an incomplete response as a successful import', async () => {
  const result = await submitParentSlotObservations(prepareParentSlotObservations([source()], observedAt), new Map([['CHILD1', 10]]), {
    rondoClubRequest: async () => ({ body: { results: [] } })
  });
  assert.equal(result.observed, 0);
  assert.equal(result.errors.length, 1);
});
