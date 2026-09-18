const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSources, buildFormerMemberPlan, fetchFormerPeople, syncFormerMembersToLaposta } = require('../steps/sync-former-members-to-laposta');
const { openDb, recordAutomaticUnsubscription, upsertMemberDeliverabilityEvents, getPendingMemberDeliverabilityEvents, buildLapostaEventKey } = require('../lib/laposta-db');

const activeResult = () => ({ success: true, sourceComplete: true, observedAt: new Date().toISOString(), members: [{ PublicPersonId: 'ACTIVE', Email: 'active@example.test', EmailAddressParent1: 'shared@example.test' }] });
const inactiveResult = () => ({ success: true, members: [{ PublicPersonId: 'FORMER', TypeOfMemberDescription: 'Oud bondslid', Email: 'former@example.test', EmailAddressParent1: 'shared@example.test', EmailAddressParent2: 'parent@example.test' }] });

test('protects shared parent addresses across lists, retains unknowns and existing opt-outs', () => {
  const lists = [{ index: 1, listId: 'one', members: [
    { member_id: 'former', email: 'FORMER@example.test', state: 'active' },
    { member_id: 'unknown', email: 'unknown@example.test', state: 'active' },
    { member_id: 'optout', email: 'parent@example.test', state: 'unsubscribed' },
    { member_id: 'parent', email: 'parent@example.test', state: 'active' },
    { member_id: 'rondo', email: 'old-alternate@example.test', state: 'active' }
  ] }, { index: 2, listId: 'two', members: [{ member_id: 'shared', email: 'SHARED@example.test', state: 'active' }] }];
  const people = [{ fields: { former_member: true, email_2: 'old-alternate@example.test' } }];
  const plan = buildFormerMemberPlan(activeResult().members, inactiveResult().members, people, lists);
  assert.deepEqual(plan.candidates.map(row => row.member.member_id), ['former', 'parent', 'rondo']);
  assert.deepEqual(plan.protectedRows.map(row => row.member.member_id), ['shared']);
});

test('an inactive non-former record alone cannot remove an address', () => {
  const plan = buildFormerMemberPlan(activeResult().members, [{ PublicPersonId: 'X', TypeOfMemberDescription: 'Relatie', Email: 'other@example.test' }], [], [{ index: 1, listId: 'one', members: [{ email: 'other@example.test' }] }]);
  assert.equal(plan.candidates.length, 0);
});

test('fails closed for incomplete, empty, stale or malformed sources', () => {
  for (const patch of [{ success: false }, { sourceComplete: false }, { members: [] }, { observedAt: '2020-01-01T00:00:00Z' }, { members: [{}] }]) {
    assert.throws(() => validateSources({ ...activeResult(), ...patch }, inactiveResult()));
  }
  assert.throws(() => validateSources(activeResult(), { success: false, members: [] }));
  assert.doesNotThrow(() => validateSources(activeResult(), inactiveResult()));
});

test('Rondo pagination must be complete and actually filtered to former members', async () => {
  await assert.rejects(fetchFormerPeople(async () => ({ headers: { 'x-wp-totalpages': '1', 'x-wp-total': '2' }, body: [{ id: 1, fields: { former_member: true } }] })), /pagination/);
  await assert.rejects(fetchFormerPeople(async () => ({ headers: { 'x-wp-totalpages': '1', 'x-wp-total': '1' }, body: [{ id: 1, fields: { former_member: false } }] })), /response/);
  let calls = 0;
  const people = await fetchFormerPeople(async () => ({ headers: { 'x-wp-totalpages': '2', 'x-wp-total': '2' }, body: [{ id: ++calls, fields: { former_member: true } }] }));
  assert.equal(people.length, 2);
});

function dependencies() {
  const db = openDb(':memory:');
  const remote = [{ member_id: 'former', email: 'former@example.test', state: 'active' }, { member_id: 'shared', email: 'shared@example.test', state: 'active' }];
  const calls = [];
  return {
    db, calls, remote,
    fetchFormerPeople: async () => [],
    getListConfig: index => ({ listId: index === 1 ? 'one' : null }),
    fetchMembers: async (listId, state) => { calls.push(['read', state]); return remote.filter(row => row.state === state).map(row => ({ ...row })); },
    waitForRateLimit: async () => {},
    openDb: () => db,
    recordAutomaticUnsubscription: (...args) => { calls.push(['journal']); recordAutomaticUnsubscription(...args); },
    updateMember: async (listId, id, change) => { calls.push(['write']); Object.assign(remote.find(row => row.member_id === id), change); }
  };
}

test('preview does not write or journal and failed sources never call remote APIs', async () => {
  const deps = dependencies();
  const preview = await syncFormerMembersToLaposta(activeResult(), inactiveResult(), { dependencies: deps });
  assert.equal(preview.candidates, 1);
  assert.equal(preview.keptShared, 1);
  assert.deepEqual(deps.calls, [['read', 'active']]);
  deps.calls.length = 0;
  const blocked = await syncFormerMembersToLaposta({ ...activeResult(), sourceComplete: false }, inactiveResult(), { apply: true, dependencies: deps });
  assert.equal(blocked.errors.length, 1);
  assert.deepEqual(deps.calls, []);
  deps.db.close();
});

test('apply journals before writing, verifies separately and leaves shared addresses active', async () => {
  const deps = dependencies();
  const result = await syncFormerMembersToLaposta(activeResult(), inactiveResult(), { apply: true, dependencies: deps });
  assert.equal(result.unsubscribed, 1);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(deps.calls, [['read', 'active'], ['journal'], ['write'], ['read', 'unsubscribed']]);
  assert.equal(deps.remote.find(row => row.member_id === 'shared').state, 'active');
  const again = await syncFormerMembersToLaposta(activeResult(), inactiveResult(), { apply: true, dependencies: { ...deps, openDb: () => { throw new Error('should not open'); } } });
  assert.equal(again.candidates, 0);
  assert.equal(again.errors.length, 0);
});

test('successful API response without persisted unsubscribe fails verification', async () => {
  const deps = dependencies();
  deps.updateMember = async () => {};
  const result = await syncFormerMembersToLaposta(activeResult(), inactiveResult(), { apply: true, dependencies: deps });
  assert.equal(result.unsubscribed, 0);
  assert.equal(result.results[0].state, 'unverified');
  assert.match(result.errors[0].message, /did not confirm/);
});

test('journal failure prevents mutation; ambiguous API success is independently checked', async () => {
  const deps = dependencies();
  deps.recordAutomaticUnsubscription = () => { throw new Error('disk failure'); };
  const result = await syncFormerMembersToLaposta(activeResult(), inactiveResult(), { apply: true, dependencies: deps });
  assert.equal(result.unsubscribed, 0);
  assert.equal(deps.remote[0].state, 'active');
  const ambiguous = dependencies();
  const update = ambiguous.updateMember;
  ambiguous.updateMember = async (...args) => { await update(...args); throw new Error('timeout'); };
  const verified = await syncFormerMembersToLaposta(activeResult(), inactiveResult(), { apply: true, dependencies: ambiguous });
  assert.equal(verified.unsubscribed, 1);
  assert.equal(verified.errors.length, 1);
});

test('normal deliverability refresh cannot turn intentional removals into tasks', () => {
  const db = openDb(':memory:');
  const member = { member_id: 'id', email: 'former@example.test' };
  recordAutomaticUnsubscription(db, 1, 'one', member, 'former-member-cleanup');
  upsertMemberDeliverabilityEvents(db, [{ list_index: 1, list_id: 'one', member_id: 'id', email: member.email, state: 'unsubscribed', event_key: buildLapostaEventKey({ listId: 'one', memberId: 'id', email: member.email, state: 'unsubscribed' }), payload: member }]);
  assert.deepEqual(getPendingMemberDeliverabilityEvents(db), []);
  assert.equal(db.prepare('SELECT ignored_reason FROM member_deliverability_events').get().ignored_reason, 'former-member-cleanup');
  db.close();
});
