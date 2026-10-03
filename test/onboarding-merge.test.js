const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initDb, upsertMembers, deleteMember } = require('../lib/rondo-club-db');
const { resolveSourceIdentity, runSourceChecks } = require('../steps/sync-onboarding-sources');
const { sourceRecord } = require('../lib/onboarding-source');

const httpError = status => Object.assign(new Error(`HTTP (${status})`), { status });

function fixture(t, targetKnvbId = 'SURVIVOR') {
  const db = new Database(':memory:');
  initDb(db);
  t.after(() => db.close());
  const prepared = { knvb_id: 'SOURCE', data: { fields: { knvb_id: 'SOURCE' } } };
  upsertMembers(db, [prepared]);
  db.prepare('UPDATE rondo_club_members SET rondo_club_id = 10, last_synced_hash = source_hash').run();
  const row = () => db.prepare('SELECT * FROM rondo_club_members WHERE knvb_id = ?').get('SOURCE');
  // This parked source never reaches syncPerson, reproducing the production gap.
  const member = { PublicPersonId: 'SOURCE', MemberStatus: 'PARKED' };
  const calls = [];
  const request = async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route === 'rondo/v1/onboarding/sources') return { body: { pending_count: 1, checks: [sourceRecord(member)] } };
    if (route === 'wp/v2/people/10') throw httpError(404);
    if (route === 'rondo/v1/people/10/merge-target') return { body: { merged_into_person_id: 20 } };
    if (route === 'wp/v2/people/20') return { body: { id: 20, fields: { knvb_id: targetKnvbId } } };
    if (route === 'rondo/v1/onboarding/simulation/20') return { body: { snapshot_hash: 'snapshot' } };
    if (route === 'rondo/v1/onboarding/observations/20') return { body: {} };
    if (route === 'rondo/v1/onboarding/sources/finish') return { body: { complete: false } };
    throw new Error(`Unexpected request: ${route}`);
  };
  const run = () => runSourceChecks({
    members: [member], observedAt: new Date().toISOString(), sourceComplete: true,
    page: null, logger: { log() {} }, request,
    openDatabase: () => ({ prepare: db.prepare.bind(db), close() {} })
  });
  return { db, prepared, row, calls, request, run };
}

test('onboarding retires an unchanged merged source and keeps the survivor untouched on repeated runs', async t => {
  const f = fixture(t);
  const first = await f.run();
  assert.equal(first.checked, 1);
  assert.equal(first.complete, 0);
  assert.deepEqual(first.errors, []);
  assert.match(first.deferred[0].message, /retired after merge into SURVIVOR/);
  assert.equal(f.row().rondo_club_id, 10);
  assert.equal(f.row().retired_into_knvb_id, 'SURVIVOR');
  assert.equal(f.row().data_json, '{}');
  assert.ok(!f.calls.some(c => /simulation|observations/.test(c.route)));
  assert.ok(f.calls.filter(c => c.route.includes('/people/')).every(c => c.method === 'GET'));
  const finish = f.calls.find(c => c.route.endsWith('/finish'));
  assert.equal(finish.body.person_id, 0);
  assert.equal(finish.body.observation_id, '');

  upsertMembers(f.db, [f.prepared]);
  deleteMember(f.db, 'SOURCE');
  const stored = f.row();
  f.calls.length = 0;
  assert.deepEqual(await f.run(), first);
  assert.deepEqual(f.row(), stored);
  assert.equal(f.calls.length, 2); // Inventory + incomplete acknowledgment only.
});

test('same-identity merge repairs the mapping before even a deferred onboarding observation', async t => {
  const f = fixture(t, 'SOURCE');
  const result = await f.run();
  assert.deepEqual(result.errors, []);
  assert.equal(result.complete, 0);
  assert.equal(f.row().rondo_club_id, 20);
  assert.equal(f.row().retired_into_knvb_id, null);
  assert.equal(f.row().last_synced_hash, null);
  assert.ok(f.calls.some(c => c.route === 'rondo/v1/onboarding/simulation/20'));
  assert.ok(!f.calls.some(c => c.route.endsWith('/simulation/10')));
});

test('unconfirmed merge failures preserve the original identity and remain errors', async t => {
  const f = fixture(t);
  const before = f.row();
  for (const status of [403, 404, 503]) {
    await assert.rejects(resolveSourceIdentity(f.db, 'SOURCE', async route => {
      throw httpError(route.endsWith('/merge-target') ? status : 404);
    }), status === 404 ? /missing without a confirmed merge/ : /HTTP/);
    assert.deepEqual(f.row(), before);
  }
});

test('an unmerged identity mismatch cannot retire or remap a source', async t => {
  const f = fixture(t);
  const before = f.row();
  await assert.rejects(resolveSourceIdentity(f.db, 'SOURCE', async () => ({
    body: { id: 10, fields: { knvb_id: 'UNRELATED' } }
  })), /another KNVB identity/);
  assert.deepEqual(f.row(), before);
});

test('a healthy mapping does not clear the completed sync hash', async t => {
  const f = fixture(t);
  const before = f.row();
  await resolveSourceIdentity(f.db, 'SOURCE', async () => ({ body: { id: 10, fields: { knvb_id: 'SOURCE' } } }));
  assert.deepEqual(f.row(), before);
});
