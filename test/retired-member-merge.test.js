const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initDb, upsertMembers, deleteMember } = require('../lib/rondo-club-db');
const { syncPerson, markFormerMembers } = require('../steps/submit-rondo-club-sync');

function fixture(t) {
  const db = new Database(':memory:');
  initDb(db);
  t.after(() => db.close());
  const member = { knvb_id: 'OLD123', rondo_club_id: 10, source_hash: 'new', data: { fields: { knvb_id: 'OLD123', first_name: 'Sander', last_name: 'Alphen', former_member: true } } };
  upsertMembers(db, [member]);
  db.prepare('UPDATE rondo_club_members SET rondo_club_id = 10 WHERE knvb_id = ?').run(member.knvb_id);
  const row = () => db.prepare('SELECT * FROM rondo_club_members WHERE knvb_id = ?').get(member.knvb_id);
  return { db, member, row };
}

function error(status) {
  return Object.assign(new Error(`HTTP (${status})`), { details: { data: { status } } });
}

function mergedApi(targetKnvbId = 'NEW123') {
  const calls = [];
  const request = async (endpoint, method, data) => {
    calls.push({ endpoint, method, data });
    if (endpoint === 'wp/v2/people/10') throw error(404);
    if (endpoint === 'rondo/v1/people/10/merge-target') return { body: { merged_into_person_id: 20 } };
    if (endpoint === 'wp/v2/people/20') return { body: { id: 20, fields: { knvb_id: targetKnvbId, former_member: false } } };
    throw new Error(`Unexpected request: ${endpoint}`);
  };
  return { calls, request };
}

test('retired source cannot overwrite or recreate its survivor, even after trash cleanup and reimport', async t => {
  const { db, member, row } = fixture(t);
  const api = mergedApi();
  const result = await syncPerson(member, db, api);
  assert.equal(result.reason, 'knvb_id_mismatch');
  assert.ok(api.calls.every(call => call.method === 'GET'));
  assert.equal(row().rondo_club_id, 10);
  assert.equal(row().retired_into_knvb_id, 'NEW123');
  assert.equal(row().data_json, '{}');
  upsertMembers(db, [{ ...member, data: { fields: { ...member.data.fields, first_name: 'Changed' } } }]);
  deleteMember(db, member.knvb_id);
  assert.equal(row().data_json, '{}');
  const again = await syncPerson(member, db, { request: () => { throw new Error('No API calls after retirement'); } });
  assert.equal(again.reason, 'retired_knvb_id');
});

test('an unmerged identity mismatch blocks writes without inventing a retirement', async t => {
  const { db, member, row } = fixture(t);
  const calls = [];
  const request = async (endpoint, method) => {
    calls.push(method);
    return { body: { id: 10, fields: { knvb_id: 'OTHER' } } };
  };
  assert.equal((await syncPerson(member, db, { request })).reason, 'knvb_id_mismatch');
  assert.deepEqual(calls, ['GET']);
  assert.equal(row().retired_into_knvb_id, null);
});

test('a merge retaining the same KNVB ID still updates and repairs its mapping', async t => {
  const { db, member, row } = fixture(t);
  const api = mergedApi('OLD123');
  assert.equal((await syncPerson(member, db, api)).action, 'updated');
  assert.equal(row().rondo_club_id, 20);
  assert.equal(row().retired_into_knvb_id, null);
  assert.equal(api.calls.filter(call => call.method === 'PUT').length, 1);
});

test('a concurrent merge rechecks the survivor identity before retrying writes', async t => {
  const { db, member, row } = fixture(t);
  const api = mergedApi();
  let oldReads = 0;
  const request = async (endpoint, method, data) => {
    if (endpoint === 'wp/v2/people/10' && method === 'GET' && oldReads++ === 0) {
      return { body: { id: 10, fields: { knvb_id: 'OLD123' } } };
    }
    return api.request(endpoint, method, data);
  };
  assert.equal((await syncPerson(member, db, { request })).reason, 'knvb_id_mismatch');
  assert.equal(row().rondo_club_id, 10);
  assert.equal(row().retired_into_knvb_id, 'NEW123');
  assert.ok(api.calls.every(call => call.method === 'GET' || (call.method === 'PUT' && call.endpoint === 'wp/v2/people/10')));
});

test('former-member cleanup retires the old source without changing the active survivor', async t => {
  const { db, member, row } = fixture(t);
  const api = mergedApi();
  const result = await markFormerMembers(db, ['NEW123'], api);
  assert.deepEqual(result, { marked: [], errors: [] });
  assert.ok(api.calls.every(call => call.method === 'GET'));
  assert.equal(row().retired_into_knvb_id, 'NEW123');
  upsertMembers(db, [member]);
  assert.equal(row().data_json, '{}');
});

test('ordinary former-member updates and genuinely deleted records retain their behavior', async t => {
  const { db, row } = fixture(t);
  const calls = [];
  const request = async (endpoint, method, data) => {
    calls.push({ method, data });
    return { body: { id: 10, fields: { knvb_id: 'OLD123' } } };
  };
  assert.equal((await markFormerMembers(db, [], { request })).marked.length, 1);
  assert.equal(calls.find(call => call.method === 'PUT').data.fields.former_member, true);
  assert.equal(row().data_json, '{}');
  assert.equal(row().retired_into_knvb_id, null);
  db.prepare("UPDATE rondo_club_members SET data_json = ?").run('{"fields":{}}');
  await markFormerMembers(db, [], { request: async () => { throw error(404); } });
  assert.equal(row(), undefined);
});

test('merge lookup failure preserves tracking and does not invent a retirement', async t => {
  const { db, row } = fixture(t);
  const request = async endpoint => { throw error(endpoint.includes('merge-target') ? 503 : 404); };
  const result = await markFormerMembers(db, [], { request });
  assert.equal(result.errors.length, 1);
  assert.equal(row().rondo_club_id, 10);
  assert.equal(row().retired_into_knvb_id, null);
});
